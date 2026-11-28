"use strict";
// Cross-probing between schematic and board (Altium: Ctrl+double-click, Cross Select Mode).
//
// Headless API (pure):
//   AtriumCrossProbe.targetAt(doc, defs, item, point)          → {kind:"part"|"pin"|"net", ...} | null
//   AtriumCrossProbe.resolve(project, defs, fromDocId, target)  → {docId, ids, net, box, label} | null
//   AtriumCrossProbe.mirror(project, defs, fromDocId, ids, toDocId) → ids in the other document
//   AtriumCrossProbe.netOf(doc, defs, item)                     → net name of a wire/track/via/pad/label
// Parts match by `part.link` (set by import-link.js and placement), then by designator.
// Nets match by name: board nets come from the schematic's net names.
//
// UI: Ctrl/Cmd+double-click probes the object under the pointer; Tools → Cross Probe (T C,
// selection) and the context menu probe the selection. Alt+click (without dragging) highlights
// the net under the pointer in place, as in Altium: it no longer leaves the sheet.
// With the split view open the other pane eases to the object (split-follow.js) without taking
// focus; otherwise the editor switches to the other document. Tools → Cross Select Mode
// mirrors every selection change into the other document, live in a split view.
globalThis.AtriumCrossProbe = (() => {
  const C = globalThis.AtriumNavCommon;
  const A = () => globalThis.Atrium;
  const upper = s => String(s || "").trim().toUpperCase();

  // ------------------------------------------------------------------ net naming
  // The editor, cross-probe and highlight mask share the sheet's local net names.
  // Read only committed journal generations here; a pointer or paint must never sync undo.
  function schematicNets(doc, defs) {
    return A().sheetNets(host?.project?.(), doc, defs, host);
  }
  function netOf(doc, defs, item) {
    if (!item) return "";
    if (doc.kind === "pcb") return item.net || "";
    if (item.kind === "netlabel") return item.text || "";
    if (item.kind === "wire") return schematicNets(doc, defs).byWire.get(item.id) || item.net || "";
    if (item.kind === "junction") {
      const n = schematicNets(doc, defs);
      for (const w of doc.items) if (w.kind === "wire" && w.points.some(p => A().same(p, [item.x, item.y]))) return n.byWire.get(w.id) || "";
    }
    return item.net || "";
  }
  function pinNet(doc, defs, part, number) {
    if (doc.kind === "pcb") {
      if (part.pinNets && Object.hasOwn(part.pinNets, number)) return part.pinNets[number] || "";
      const pad = defs.get(part.def)?.footprint?.pads?.find(p => p.number === number);
      return pad?.net || "";
    }
    return schematicNets(doc, defs).byPin.get(part.id + "/" + number) || "";
  }
  // The pin or pad of `part` under `point`, if any.
  function pinAt(doc, defs, part, point) {
    const def = defs.get(part.def);
    let best = null;
    for (const pin of A().pins(part, def, doc.kind)) {
      if (pin.hidden) continue;
      const r = doc.kind === "pcb" ? Math.max(pin.w || 0, pin.h || 0, pin.diameter || 0) / 2 || .4 : .9;
      const d = Math.hypot(pin.at[0] - point[0], pin.at[1] - point[1]);
      if (d <= r && (!best || d < best.d)) best = {d, pin};
    }
    return best?.pin || null;
  }

  // ------------------------------------------------------------------ targets
  function targetAt(doc, defs, item, point) {
    if (!item) return null;
    if (item.kind === "part") {
      const pin = point ? pinAt(doc, defs, item, point) : null;
      if (pin) return {kind:"pin", partId:item.id, link:item.link || "", ref:item.ref || "", pin:String(pin.number), net:pinNet(doc, defs, item, pin.number), docId:doc.id};
      return {kind:"part", partId:item.id, link:item.link || "", ref:item.ref || "", docId:doc.id};
    }
    const net = netOf(doc, defs, item);
    if (net) return {kind:"net", net, docId:doc.id};
    return null;
  }
  // Probe target for a selection (keyboard / menu): the first part, else the first net.
  function targetForSelection(doc, defs, ids, highlight = "") {
    const items = doc.items.filter(i => ids.includes(i.id));
    const part = items.find(i => i.kind === "part");
    if (part) return targetAt(doc, defs, part, null);
    for (const i of items) {const t = targetAt(doc, defs, i, null); if (t) return t;}
    return highlight ? {kind:"net", net:highlight, docId:doc.id} : null;
  }

  // ------------------------------------------------------------------ resolve
  function counterparts(project, from) {
    const kind = from.kind === "pcb" ? "schematic" : "pcb";
    const docs = project.documents.filter(d => d.kind === kind);
    const pref = globalThis.Atrium?.preferredDocument?.(project, kind, null);
    return pref ? [pref, ...docs.filter(d => d !== pref)] : docs;
  }
  function findPart(project, from, t) {
    const docs = counterparts(project, from);
    if (t.link) for (const d of docs) {const p = d.items.find(i => i.kind === "part" && i.link === t.link); if (p) return {doc:d, part:p};}
    const ref = upper(t.ref);
    if (ref && !/[?*]/.test(ref)) for (const d of docs) {const p = d.items.find(i => i.kind === "part" && upper(i.ref) === ref); if (p) return {doc:d, part:p};}
    return null;
  }
  const memberCache = new WeakMap();
  function compiledNetMembers(compiled) {
    let docs = memberCache.get(compiled);
    if (docs) return docs;
    docs = new Map();
    for (const {inst, net} of compiled.local) {
      let instances = docs.get(inst.doc.id);
      if (!instances) docs.set(inst.doc.id, instances = new Map());
      let member = instances.get(inst.id);
      if (!member) instances.set(inst.id, member = {doc:inst.doc, instance:inst.id, ids:new Set(), pins:[]});
      for (const wire of net.wires) member.ids.add(wire.id);
      for (const source of net.sources) member.ids.add(source.item.id);
    }
    for (const p of compiled.pins) docs.get(p.doc.id)?.get(p.instance)?.pins.push(p);
    memberCache.set(compiled, docs);
    return docs;
  }
  // Selectable objects and pin bounds have different rules from electrical connectivity.
  function collectNetObjects(doc, defs, rows, {instanceId=undefined,terminals=false}) {
    const single = rows.size === 1, [name,only] = rows.entries().next().value;
    const forNet = net => single ? (net === name ? only : null) : rows.get(net);
    const addItem = (row,item) => {row.ids.push(item.id); row.box = C.union(row.box,C.itemBox(doc,defs,item));};
    const addPin = (row,pin,r) => {
      const [x,y] = pin.at;
      row.box = C.union(row.box,[x-r,y-r,x+r,y+r]);
    };
    const addPartPins = (part,netOf,radius) => {
      const counts = terminals ? new Map() : null, board = doc.kind === "pcb";
      const pins = A().pins(part,defs.get(part.def),doc.kind);
      for (let slot=0;slot<pins.length;slot++) {
        const pin=pins[slot], number=String(pin.number ?? ""), occurrence=counts?.get(number) || 0;
        if (board || !pin.hidden) counts?.set(number,occurrence+1);
        const row=forNet(netOf(pin));
        if (!row) continue;
        addPin(row,pin,radius(pin));
        if (row.subs && (board || !pin.hidden)) row.subs.push(terminalReference(doc,part,pin,slot,number,occurrence));
      }
    };
    if (doc.kind === "pcb") {
      for (const i of doc.items) {
        if (i.kind === "track" || i.kind === "via" || i.kind === "pad" || i.kind === "polygon") {
          const row = forNet(i.net); if (row) addItem(row,i);
        } else if (i.kind === "part" && i.pinNets)
          addPartPins(i,pin=>i.pinNets?.[pin.number] ?? pin.net,pin=>Math.max(pin.w || 0,pin.h || 0,.4)/2);
      }
    } else {
      const project=host?.project?.();
      const occurrence=instanceId && project && globalThis.AtriumHierarchy?.compileCached?.(project,{defs,publish:false})?.byInstance.get(instanceId);
      const n = occurrence || schematicNets(doc, defs);
      for (const i of doc.items) {
        if (i.kind === "wire" || ["netlabel","power","port","offsheet"].includes(i.kind)) {
          const row = forNet(i.kind === "wire" ? n.byWire.get(i.id) ?? i.net : i.text ?? i.name);
          if (row) addItem(row,i);
        } else if (i.kind === "part") addPartPins(i,pin=>n.byPin.get(i.id + "/" + pin.number),()=>1);
      }
    }
  }
  const netMemo = new WeakMap();
  function rememberedNets(doc,defs) {
    if (host?.defs?.() !== defs || host?.drag?.()?.before) return null;
    const project = host?.project?.(), revision = host?.revision?.();
    const version = globalThis.AtriumUndoStore?.documentVersions?.(doc,project);
    if (!project || revision == null || !version) return null;
    const key = [project,revision,defs,doc.kind,doc.items,doc.items.length,doc.sourceName,version.floor,version.items,version.outer,
      version.library,globalThis.AtriumSchObjects,globalThis.AtriumPCBDraw];
    const old = netMemo.get(doc);
    if (old?.key.every((value,i) => value === key[i])) return old.rows;
    const rows = new Map(); netMemo.set(doc,{key,rows}); return rows;
  }
  function netObjectsBatch(doc,defs,nets,options = {}) {
    const result = new Map(), missing = new Map();
    const saved = options.instanceId || options.terminals ? null : rememberedNets(doc,defs);
    for (const net of nets) {
      if (result.has(net)) continue;
      const old = saved?.get(net);
      if (old) result.set(net,{ids:old.ids.slice(),box:old.box?.slice() ?? null});
      else {
        const row = {ids:[],box:null,...(options.terminals && {subs:[]})};
        result.set(net,row);
        if (!Number.isNaN(net)) missing.set(net,row);
      }
    }
    if (missing.size) collectNetObjects(doc,defs,missing,options);
    if (saved) for (const [name,row] of missing) {
      if (saved.size >= 64) saved.delete(saved.keys().next().value);
      saved.set(name,{ids:row.ids.slice(),box:row.box?.slice() ?? null});
    }
    return result;
  }
  function netObjects(doc,defs,net,instanceId) {
    return netObjectsBatch(doc,defs,[net],{instanceId}).get(net);
  }
  function terminalReference(doc,part,pin,slot,number,occurrence) {
    return {id:A().terminalId(part.id,pin,number,occurrence),ownerId:part.id,pin:number,
      ...(doc.kind === "pcb" && {padIndex:slot,padId:pin.id}),at:pin.at,
      w:typeof pin.w === "number" ? pin.w : undefined,h:typeof pin.h === "number" ? pin.h : undefined};
  }
  function terminal(doc, defs, part, {id, pin, padIndex, padId, includeNet = true}) {
    if (part.kind !== "part") return null;
    const pins = A().pins(part, defs.get(part.def), doc.kind);
    const counts = new Map(), board = doc.kind === "pcb";
    for(let slot=0;slot<pins.length;slot++) {
      const value = pins[slot], number = String(value.number ?? "");
      if (!board && value.hidden) continue;
      const occurrence = counts.get(number) || 0;
      counts.set(number,occurrence+1);
      if (pin != null && number !== String(pin) || (padId != null ? value.id !== padId : padIndex != null && slot !== padIndex)) continue;
      const reference=terminalReference(doc,part,value,slot,number,occurrence);
      if (id && id !== part.id && id !== reference.id) continue;
      const net = includeNet ? (board ? part.pinNets?.[value.number] ?? value.net : pinNet(doc,defs,part,value.number)) : undefined;
      return {...reference, net};
    }
    return null;
  }
  function resolveLocal(doc, defs, target) {
    if (target.kind === "net") {
      const net = target.net ?? target.fields?.["net.name"] ?? target.fields?.name ??
        (target.id?.startsWith("net/") ? target.id.slice(4) : null);
      if (!net) return null;
      return {...netObjects(doc,defs,net,target.instanceId),net,label:net};
    }
    const item = doc.items.find(row => row.id === (target.ownerId ?? target.id));
    if (!item) return null;
    let box = C.itemBox(doc,defs,item), net = target.net;
    if (target.pin != null || target.padIndex != null || target.padId != null) {
      const pad = terminal(doc,defs,item,target);
      if (!pad) return null;
      const [x,y] = pad.at, r = Math.max(pad.w || 0,pad.h || 0,1)*2;
      box = [x-r,y-r,x+r,y+r];
      net = pad.net;
    }
    return {ids:[item.id],box,net,label:item.ref || item.text || item.name || "Object"};
  }
  function resolve(project, defs, fromDocId, t) {
    const from = project.documents.find(d => d.id === fromDocId);
    if (!from || !t) return null;
    if (t.kind === "part" || t.kind === "pin") {
      const hit = findPart(project, from, t);
      if (!hit) return null;
      const {doc, part} = hit;
      let box = C.itemBox(doc, defs, part), net = "", label = part.ref || "component";
      if (t.kind === "pin") {
        const pin = A().pins(part, defs.get(part.def), doc.kind).find(p => String(p.number) === t.pin);
        if (pin) {const r = Math.max(pin.w || 0, pin.h || 0, 1.2) * 1.5; box = [pin.at[0] - r, pin.at[1] - r, pin.at[0] + r, pin.at[1] + r]; net = pinNet(doc, defs, part, pin.number); label += "-" + t.pin;}
      }
      return {docId:doc.id, ids:[part.id], net, box, label, kind:t.kind};
    }
    if (t.kind === "net") {
      for (const doc of counterparts(project, from)) {
        const found = netObjects(doc, defs, t.net);
        if (found.box) return {docId:doc.id, ids:found.ids, net:t.net, box:found.box, label:"net " + t.net, kind:"net"};
      }
    }
    return null;
  }
  // Selection mirror (Cross Select Mode): parts by link or designator, copper and wires by net.
  function mirror(project, defs, fromDocId, ids, toDocId) {
    const from = project.documents.find(d => d.id === fromDocId), to = project.documents.find(d => d.id === toDocId);
    if (!from || !to || from === to || !ids.length) return [];
    const want = new Set(ids), links = new Set(), refs = new Set(), nets = new Set();
    for (const i of from.items) {
      if (!want.has(i.id)) continue;
      if (i.kind === "part") {if (i.link) links.add(i.link); else if (i.ref) refs.add(upper(i.ref));}
      else {const n = netOf(from, defs, i); if (n) nets.add(n);}
    }
    const out = [];
    for (const i of to.items) if (i.kind === "part" && (i.link && links.has(i.link) || !i.link && refs.has(upper(i.ref)) || i.link && refs.has(upper(i.ref)))) out.push(i.id);
    if (nets.size) for (const {ids} of netObjectsBatch(to,defs,nets).values()) for (const id of ids) out.push(id);
    return [...new Set(out)];
  }

  // ------------------------------------------------------------------ UI
  let host = null, crossSelect = false, applying = false;
  const overrides = new Map();   // docId → ids to show (inactive pane) and apply when it activates
  crossSelect = C.crossSelectEnabled();

  // The inactive split pane eases to the target (split-follow.js, when loaded); the camera keeps a flipped board flipped.
  const keyboardProbe = () => globalThis.document?.documentElement?.dataset?.motionInput === "keyboard";
  function zoomPane(pane, box, other, keyboard) {
    if (!pane?.view || !box) return;
    const F = globalThis.AtriumSplitFollow;
    if (other && F?.glide) {F.glide(pane, box, {kind:host?.docById(pane.docId)?.kind, force:true, level:keyboard?"off":null}); return;}
    const w = pane.canvas.clientWidth || 800, h = pane.canvas.clientHeight || 600, cam = pane.view.camera();
    const target = {...cam, ...C.cameraFor(box, w, h, cam)}, camera = globalThis.AtriumCamera;
    if (!other && camera?.flyTo) camera.flyTo(target,{view:pane.view,canvas:pane.canvas,ms:keyboard?0:undefined});
    else pane.view.restoreCamera(target);
  }
  function otherLabel(kind) {return kind === "pcb" ? "schematic" : "board";}
  // Carry out a resolved probe. Never steals focus from the active pane in split view.
  function go(res, keyboard = keyboardProbe()) {
    if (!host || !res) return false;
    if (globalThis.AtriumProjectWindowClient?.routeProbe(res, keyboard)) return true;
    const panes = host.panes(), active = panes.find(p => p.active), other = panes.find(p => !p.active);
    if (res.net) host.setHighlight(res.net);
    if (active && active.docId === res.docId) {
      host.select(res.ids);zoomPane(active, res.box, false, keyboard);host.redraw();
    } else if (other && host.showInOther(res.docId)) {
      overrides.set(res.docId, res.ids);
      zoomPane(host.panes().find(p => !p.active), res.box, true, keyboard);host.invalidate();
    } else {
      overrides.delete(res.docId);
      host.selectDocument(res.docId);host.select(res.ids);
      zoomPane(host.panes().find(p => p.active), res.box, false, keyboard);host.redraw();
    }
    host.info("Cross-probe: " + res.label + " in " + (host.docById(res.docId)?.name || "the other document"));
    return true;
  }
  function probe(target, keyboard = keyboardProbe()) {
    if (!host) return false;
    if (!target) {host.info("Select a component, pin or net to cross-probe."); return false;}
    if (globalThis.AtriumProjectWindowClient?.probeHere(target, keyboard)) return true;
    const p = host.project(), fromId = target.docId || host.currentId();
    if (target.kind === "net" && host.docById?.(fromId)?.kind === "pcb" && globalThis.document?.createElement) {
      const preview = globalThis.AtriumConnectionPreview;
      if (!preview && globalThis.AtriumLazy) {
        globalThis.AtriumLazy.need("AtriumConnectionPreview").then(() => {if (host.project()===p && host.currentId()===fromId) probe(target,keyboard);}, err=>host.info(err.message));
        return true;
      }
      if (preview) {
        const graph = preview.current() || globalThis.AtriumSheetConnections.index(globalThis.AtriumHierarchy.compileCached(p,{defs:host.defs()}));
        if (preview.probe(graph.connectionsFor(target.net),target.net,keyboard)) return true;
      }
    }
    const res = resolve(p, host.defs(), fromId, target);
    if (!res) {
      const what = target.kind === "net" ? "Net " + target.net : (target.ref || "This component") + (target.kind === "pin" ? "-" + target.pin : "");
      host.info(what + " has no match in the " + otherLabel(host.docById(target.docId || host.currentId())?.kind) + ".");
      return false;
    }
    return go(res,keyboard);
  }
  function probeSelection() {
    const d = host.doc();
    return probe(targetForSelection(d, host.defs(), host.selection(), host.highlight()));
  }
  function doubleClick(hit) {
    const item = hit?.item;
    const hierarchy = host.tool() === "select" && item && hit.doc.kind === "schematic" &&
      (globalThis.AtriumHierarchy.sourceType(item) ||
        item.kind === "sheetsymbol" && globalThis.AtriumSchObjects.entryAt(item, hit.point, 5 / hit.pane.view.scale()));
    if (hierarchy) {
      if (globalThis.AtriumConnectionPreview) globalThis.AtriumConnectionPreview.direct(hit);
      else globalThis.AtriumLazy.need("AtriumConnectionPreview").then(ui => {
        if (host.docById(hit.doc.id) === hit.doc) ui.direct(hit);
      }, err => host.info(err.message));
      return;
    }
    if (!hit?.item) {host.info("Nothing to cross-probe here."); return false;}
    return probe(targetAt(hit.doc, host.defs(), hit.item, hit.point));
  }
  // Alt+click: highlight the net of the wire, pin, pad or track under the pointer (the editor dims the rest).
  function highlightHit(hit) {
    if (!hit?.item) {if (host.clearHighlight?.()) host.info("Net highlight cleared."); return false;}
    const t = targetAt(hit.doc, host.defs(), hit.item, hit.point), net = t?.net || "";
    if (!net) {host.info((t?.ref || "This object") + (t?.kind === "pin" ? "-" + t.pin : "") + " is not on a net."); return false;}
    host.setHighlight(net);
    const clear = globalThis.AtriumKeymap?.hintFor("query-clear", hit.doc.kind);
    host.info("Net " + net + " highlighted. " + (clear ? clear + " or a click" : "A click") + " on empty canvas clears it.");
    return true;
  }
  function setCrossSelect(on) {
    crossSelect = !!on;
    try {globalThis.localStorage?.setItem("atrium-cross-select", crossSelect ? "1" : "0");} catch {}
    C.setChecked("cross-select", crossSelect);
    if (!crossSelect) {overrides.clear(); host?.invalidate();} else selectionChanged();
    host?.info(crossSelect ? "Cross Select Mode on: selections mirror between schematic and board." : "Cross Select Mode off.");
  }
  function selectionChanged() {
    if (!host || applying) return;
    if (!crossSelect) {if (overrides.size) {overrides.clear(); host.invalidate();} return;}
    const d = host.doc(), ids = host.selection();
    overrides.clear();
    for (const other of host.project().documents) {
      if (other.kind === d.kind) continue;
      overrides.set(other.id, mirror(host.project(), host.defs(), d.id, ids, other.id));
    }
    host.invalidate();
  }
  function documentChanged() {
    const id = host.currentId(), ids = overrides.get(id);
    if (!ids) return;
    overrides.delete(id);
    applying = true;
    try {host.select(ids);} finally {applying = false;}
    if (crossSelect) selectionChanged();
  }

  // ---- context menu (right-click on the canvas, Shift+F10 or the Menu key)
  let menu = null, menuReturn = null;
  function closeMenu(refocus = true) {
    globalThis.AtriumContextMenu?.close?.(refocus); // integ-ctx
    if (!menu) return;
    const m = menu; menu = null; m.remove();
    if (refocus) (menuReturn || host?.canvas())?.focus?.();
    menuReturn = null;
  }
  function openMenu(x, y, opts = {}) {
    closeMenu(false);
    if (!host) return null;
    // Per-object menus (context-menu.js, lazy): loaded on the first right-click.
    const CM = globalThis.AtriumContextMenu, L = globalThis.AtriumLazy;
    if (CM) return CM.open(host, x, y, opts);
    if (!opts.fallback && L?.modules?.().includes("AtriumContextMenu")) {L.need("AtriumContextMenu").then(() => openMenu(x, y, opts), () => openMenu(x, y, {...opts, fallback:true})); return null;}
    const d = host.doc(), defs = host.defs(), sel = host.selection(), target = opts.target || targetForSelection(d, defs, sel, "");
    const net = target?.net || (target?.kind === "net" ? target.net : "") || "";
    const entries = [];
    const add = (label, run, {hint = "", disabled = false} = {}) => entries.push({label, run, hint, disabled});
    const sep = () => entries.push(null);
    const K = globalThis.AtriumKeymap, hint = id => K?.hintKey(id, d.kind) || "";
    add(d.kind === "pcb" ? "Show in Schematic" : "Show on Board", () => probe(target), {hint:hint("cross-probe"), disabled:!target});
    if (net) {
      add("Highlight Net " + net, () => host.setHighlight(net));
      if (globalThis.AtriumNetsPanel) add("Show Net in Nets Panel", () => AtriumNetsPanel.reveal(net));
    }
    if (host.highlight()) add("Clear Net Highlight", () => host.setHighlight(""));
    add(d.kind === "pcb" ? "Show in PCB List" : "Show in SCH List", () => globalThis.AtriumPCBList ? AtriumPCBList.open({scope:"selection"}) : host.act("pcb-list"), {hint:hint("pcb-list"), disabled:!sel.length});
    sep();
    for (const [id, label] of [["copy", "Copy"], ["cut", "Cut"], ["duplicate", "Duplicate"], ["rotate", "Rotate"], ["delete", "Delete"]])
      add(label, () => host.act(id), {hint:hint(id), disabled:!sel.length});
    sep();
    add("Cross Select Mode", () => setCrossSelect(!crossSelect), {hint:crossSelect ? "On" : "Off"});
    add("Properties", () => {if (document.body.classList.contains("hide-right")) host.act("toggle-right");}, {hint:hint("toggle-right")});
    menu = C.el("div", null, "nav-menu"); globalThis.AtriumWorkbench?.wholePixels(menu); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Object actions");
    const items = [];
    for (const e of entries) {
      if (!e) {if (menu.lastChild && menu.lastChild.tagName !== "HR") menu.append(C.el("hr")); continue;}
      const b = C.el("button", null, "nav-menu-item"); b.type = "button"; b.setAttribute("role", "menuitem"); b.disabled = e.disabled;
      b.append(C.el("span", e.label));
      if (e.hint) b.append(e.hint === "On" || e.hint === "Off" ? C.el("span", e.hint) : AtriumShortcut.render(e.hint, {variant:"inline"}));
      b.onclick = () => {closeMenu(); e.run();};
      menu.append(b); items.push(b);
    }
    menu.addEventListener("keydown", ev => {
      const live = items.filter(b => !b.disabled), at = live.indexOf(document.activeElement);
      const k = ev.key;
      if (k === "Escape" || k === "Tab") {ev.preventDefault(); ev.stopPropagation(); closeMenu(); return;}
      const step = {ArrowDown:1, ArrowUp:-1}[k];
      if (step) {ev.preventDefault(); ev.stopPropagation(); live[(at + step + live.length) % live.length]?.focus(); return;}
      if (k === "Home" || k === "End") {ev.preventDefault(); ev.stopPropagation(); (k === "Home" ? live[0] : live.at(-1))?.focus(); return;}
      ev.stopPropagation();
    });
    menu.addEventListener("focusout", ev => {if (menu && !menu.contains(ev.relatedTarget)) closeMenu(false);});
    menu.addEventListener("mousedown", ev => ev.preventDefault());
    document.body.append(menu);
    const r = menu.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    menu.style.left = Math.max(4, Math.min(x, W - r.width - 4)) + "px";
    menu.style.top = Math.max(4 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0), Math.min(y, H - r.height - 4)) + "px"; // below the title bar
    menuReturn = opts.returnFocus || host.canvas();
    items.find(b => !b.disabled)?.focus();
    return menu;
  }
  function openMenuForSelection() {
    const c = host.canvas(), b = c.getBoundingClientRect(), d = host.doc(), sel = host.selection();
    let at = [b.left + b.width / 2, b.top + b.height / 2];
    const item = d.items.find(i => i.id === sel[0]), box = item && C.itemBox(d, host.defs(), item);
    if (box) {const s = host.view().worldToScreen([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]); at = [b.left + s[0], b.top + s[1]];}
    return openMenu(at[0], at[1]);
  }

  function attach(h) {
    host = h;
    host.registerAction("cross-probe", probeSelection);
    host.registerAction("cross-select", () => setCrossSelect(!crossSelect));
    host.registerAction("context-menu", openMenuForSelection);
    host.on("selection", selectionChanged);
    host.on("document", documentChanged);
    // Inactive pane: show the probed or mirrored objects as its selection.
    host.addRenderer((d, info) => {
      if (info.active) return null;
      const ids = overrides.get(d.id);
      return ids ? {selectedIds:new Set(ids), selected:ids[0] ?? null} : null;
    });
    if (crossSelect) selectionChanged();
  }
  C?.ready(attach);

  return {targetAt, targetForSelection, resolve, resolveLocal, compiledNetMembers, terminal, mirror, netOf, pinNet, netObjects, netObjectsBatch, schematicNets,
    go, probe, probeSelection, doubleClick, highlightHit,
    highlightAt: (canvas, x, y) => highlightHit(host.hit(canvas, x, y)), setCrossSelect, crossSelect:() => crossSelect, openMenu, closeMenu, attach,
    closeMenuIfOutside(target) { if (menu && !menu.contains(target)) closeMenu(false); }};
})();
