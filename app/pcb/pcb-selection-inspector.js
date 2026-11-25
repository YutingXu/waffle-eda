"use strict";

// Selection Properties for both editors: Locked, multi-object editing with <varies> and kind
// chips; on boards also side, copper fields, the rule clamp, Find Similar and snap. Pulled in by
// the first selected object, after the host and model are ready. One implementation serves sheets
// and boards, so a schematic multi-selection edits the same way a board one does.
globalThis.AtriumPCBSelectionInspector = (() => {
  // Plural kind names for schematic objects (boards use pcb-edit's LABELS).
  const SCH_LABELS = {part: "Components", wire: "Wires", bus: "Buses", busentry: "Bus entries", netlabel: "Net labels", power: "Power ports",
    port: "Ports", offsheet: "Off sheet connectors", junction: "Junctions", sheetsymbol: "Sheet symbols", sheetentry: "Sheet entries",
    text: "Texts", note: "Notes", textframe: "Text frames", noerc: "No ERC markers", line: "Lines", rect: "Rectangles", arc: "Arcs", polygon: "Polygons", image: "Images"};
  function install(ctx, {el, button, isBottom, LABELS, plural, guardLocked, changeSnap}) {
    const {isLocked, applyLock, lockPlan, applyFlip, flipPlan, unionOf, sharedFields, applyField, ruleCheck, VARIES, similarProps, findSimilar, snapPrefs} = globalThis.AtriumPCBEdit;
    // ---------- Properties
    function lockToggle(parent, items) {
      const l = el("label", null, "field-row pcb-edit-check"), box = el("input"); box.type = "checkbox";
      const all = items.every(isLocked), some = items.some(isLocked);
      box.checked = all; box.indeterminate = some && !all; box.setAttribute("aria-label", "Locked");
      box.onchange = () => { const ids = items.map(i => i.id); ctx.edit(() => applyLock(ctx.doc(), lockPlan(ctx.doc(), ids, box.checked)), undefined, items); };
      l.append(el("span", "Locked"), box); parent.append(l); return box;
    }
    const kindLabel = kind => (ctx.pcb() ? LABELS[kind] : SCH_LABELS[kind]) || kind;
    function inspectItem(section, item) {
      const ui = globalThis.AtriumNavHost.ui;
      if (ctx.pcb() && item.kind === "part" && ctx.defs().get(item.def)?.footprint) {
        const sel = ui.field(section, "Side", isBottom(item) ? "Bottom" : "Top", null, {values: ["Top", "Bottom"]});
        const go = () => {
          const doc = ctx.doc(); let changed = [];
          ctx.edit(() => {
            const parts = applyFlip(doc, ctx.project(), flipPlan(doc, ctx.defs(), [item.id], {about:"each"}), ctx.defs());
            changed = parts.concat(ctx.afterFlip?.(parts.map(p => p.id)) || []);
          }, undefined, () => [{doc, items:changed, library:true}]);
        };
        // Changing side moves a placed part: locked parts ask first, as drag and nudge do.
        sel.onchange = () => { if (guardLocked([item.id], "Flip", go)) go(); else sel.value = isBottom(item) ? "Bottom" : "Top"; };
      }
      lockToggle(section, [item]);
      if (unionOf(item)) {
        const u = unionOf(item);
        ui.row(section, "Union", ctx.doc().items.filter(i => unionOf(i) === u).length + " objects");
      }
      if (item.kind === "track" || item.kind === "pad" || item.kind === "via") copperFields(section, item);
    }
    function copperFields(s, item) {
      const {field, row} = globalThis.AtriumNavHost.ui, {inspect, info, len} = ctx;
      const edit = fn => ctx.edit(fn, undefined, [item]);
      const d = ctx.doc(), defs = ctx.defs(), project = ctx.project();
      const unitLabel = name => name + " (" + ctx.unit() + ")";
      if(item.kind==="track"){
        field(s,unitLabel("Width"),item.width,v=>{
          const changed = item.width !== v;
          const accepted = edit(() => item.width = v);
          if (changed && accepted !== false && !item.locked && item.width === v)
            globalThis.AtriumMacros?.recordCurrent("butter.macros.set-track-width", {width:v}, {changed:1}, "write");
          return accepted;
        },{length:true,min:.001,key:"width"});
        field(s,"Layer",item.layer||"Top",v=>edit(()=>item.layer=v),{values:ctx.layers()});
        if(item.layer==="Top" || item.layer==="Bottom"){
          for(const [key,label] of [["maskExpansion","Solder mask expansion"],["pasteExpansion","Paste mask expansion"]]){
            const input=field(s,unitLabel(label),item[key],v=>edit(()=>{if(v==null)delete item[key];else item[key]=v;}),{length:true,allowEmpty:true,key});
            input.placeholder="Covered";
            input.title="Blank leaves the track covered. Zero opens the copper width. A signed length expands or contracts each edge.";
          }
        }
      }
      if(["via","track","pad"].includes(item.kind))field(s,"Net",item.net||"",v=>edit(()=>item.net=v),{allowEmpty:true});
      if(item.kind==="pad")padFields(s,item,edit,unitLabel);
      if(item.kind!=="via")return;
      const VS=globalThis.AtriumViaStack;
      if(!VS){
        field(s,unitLabel("Diameter"),item.diameter,v=>{if(v<=item.drill){info("Diameter must exceed drill size.");inspect();return;}edit(()=>item.diameter=v);},{length:true,min:.001,key:"diameter"});
        field(s,unitLabel("Drill"),item.drill,v=>{if(v>=item.diameter){info("Drill size must be smaller than the diameter.");inspect();return;}edit(()=>item.drill=v);},{length:true,min:.001,key:"drill"});
        return;
      }
      viaStackSection(s,item,VS);
    }
    // A pad's mask and paste openings and its plating, in place (blank follows the design rules).
    function padFields(s,item,edit,unitLabel){
      const {field}=globalThis.AtriumNavHost.ui,smd=!(item.drill>0),outer=item.layer==="Top"||item.layer==="Bottom",first=s.lastChild;
      const expansion=(key,label,title)=>{
        const input=field(s,unitLabel(label),item[key],v=>edit(()=>{if(v==null)delete item[key];else item[key]=v;}),{length:true,allowEmpty:true,key});
        input.placeholder="Rule";input.title=title;
      };
      expansion("maskExpansion","Mask expand","Blank follows the solder mask rule. A signed length grows or shrinks the opening on each edge.");
      if(smd&&outer){
        const l=el("label",null,"field-row pcb-edit-check"),box=el("input");box.type="checkbox";box.checked=!item.noPaste;box.setAttribute("aria-label","Paste");
        box.onchange=()=>edit(()=>{if(box.checked)delete item.noPaste;else item.noPaste=true;});l.append(el("span","Paste"),box);s.append(l);
        if(!item.noPaste)expansion("pasteExpansion","Paste expand","Blank follows the paste mask rule. A signed length grows or shrinks the stencil opening on each edge.");
      }
      if(!smd){
        const l=el("label",null,"field-row pcb-edit-check"),box=el("input");box.type="checkbox";box.checked=item.plated!==false;box.setAttribute("aria-label","Plated");
        box.onchange=()=>edit(()=>{if(box.checked)delete item.plated;else item.plated=false;});l.append(el("span","Plated"),box);s.append(l);
      }
      // After the pad's size and hole (the board drawing adds those when the fields land in the section).
      const rows=[];for(let n=first?first.nextSibling:s.firstChild;n;n=n.nextSibling)rows.push(n);
      queueMicrotask(()=>{const host=rows[0]?.parentElement;if(host)host.append(...rows);});
    }
    // The via's whole construction in place, as Altium's via Properties: template, span, lands, drill,
    // protection and back-drill. Each change is one undo step and detaches the via from its template, as
    // the Via Stack dialog does; Cross-section… keeps the drawing and the per-layer land shapes.
    function viaStackSection(itemSection,item,VS){
      const {field,row,section}=globalThis.AtriumNavHost.ui,{inspect,info}=ctx;
      const d=ctx.doc(),defs=ctx.defs(),project=ctx.project(),keys=VS.keysOf(d,item,defs),mode=VS.modeOf(item);
      // Its own section after the via's: the fields may be built in a fragment that lands in the via's section.
      const s=section(itemSection,"Via Stack");s.classList.add("pcb-via-stack");
      queueMicrotask(()=>{const host=s.parentElement?.closest(".inspect-section");if(host)host.after(s);});
      const unitLabel=name=>name+" ("+ctx.unit()+")";
      const change=fn=>ctx.edit(()=>{fn();delete item.template;if(VS.modeOf(item)!=="simple")VS.sync(item,VS.keysOf(d,item,defs));},undefined,[item]);
      const check=(label,on,set)=>{const l=el("label",null,"field-row pcb-edit-check"),box=el("input");box.type="checkbox";box.checked=!!on;box.setAttribute("aria-label",label);box.onchange=()=>set(box.checked);l.append(el("span",label),box);s.append(l);return box;};
      // Template.
      const templates=VS.templates(d,project);
      const tpl=field(s,"Template",item.template&&VS.find(d,item.template,project)?item.template:"",v=>{const t=VS.find(d,v,project);ctx.edit(()=>{if(!t){delete item.template;return;}VS.applyTemplate(item,t);if(VS.modeOf(item)!=="simple")VS.sync(item,VS.keysOf(d,item,defs));},undefined,[item]);},
        {values:[["","— None —"],...templates.map(t=>[t.id,t.name+(t.source==="builtin"?" (stock)":"")])]});
      tpl.setAttribute("aria-label","Via template");
      // Span.
      const [a,b]=VS.spanOf(item),layers=[...keys,...[a,b].filter(k=>!keys.includes(k))];
      const setSpan=(from,to)=>{
        if(from===to){info("A via spans two different layers.");inspect();return;}
        change(()=>{if(from===keys[0]&&to===keys.at(-1)){delete item.fromLayer;delete item.toLayer;}else{item.fromLayer=from;item.toLayer=to;}if(VS.modeOf(item)!=="simple")VS.setMode(item,VS.modeOf(item),keys);});
      };
      field(s,"From layer",a,v=>setSpan(v,b),{values:layers});
      field(s,"To layer",b,v=>setSpan(a,v),{values:layers});
      check("Laser µvia",VS.isMicrovia(item,keys),on=>change(()=>{item.microvia=on;}));
      // Lands: one size, or a size per layer (top, middle and bottom, or every layer).
      // Long mode names (Altium's), so a select rather than a segmented control.
      field(s,"Pad stack",mode,m=>{if(VS.modeOf(item)!==m)change(()=>VS.setMode(item,m,keys));},{values:VS.MODES});
      if(mode==="simple"){
        field(s,unitLabel("Diameter"),item.diameter,v=>{if(v<=item.drill){info("Diameter must exceed drill size.");inspect();return;}change(()=>{item.diameter=v;});},{length:true,min:.001,key:"diameter"});
        field(s,"Shape",item.shape||"round",v=>change(()=>{if(v==="round")delete item.shape;else item.shape=v;}),{values:VS.SHAPES});
      }else{
        const span=keys.filter(k=>VS.inSpan(item,k));
        const rows=mode==="tmb"?[["Top","Top"],["Mid","Middle"],["Bottom","Bottom"]].filter(([k])=>k!=="Mid"||span.length>2):span.map(k=>[k,k]);
        for(const [k,label] of rows){
          const layer=mode!=="tmb"?k:k==="Top"?span[0]:k==="Bottom"?span.at(-1):span[1];
          if(layer&&VS.backdrilled(item,layer)){row(s,"Land · "+label,"Removed by back-drill");continue;}
          field(s,unitLabel("Land · "+label),item.padStack?.[k]?.diameter??item.diameter,v=>{if(v<=item.drill){info("A land must exceed the drill size.");inspect();return;}change(()=>{item.padStack[k]={...item.padStack[k],diameter:v};});},{length:true,min:.001});
        }
      }
      field(s,unitLabel("Drill"),item.drill,v=>{if(v>=VS.minDiameter(item,keys)){info("Drill size must be smaller than the smallest land.");inspect();return;}change(()=>{item.drill=v;});},{length:true,min:.001,key:"drill"});
      // Protection (IPC-4761) and the mask on each side.
      const ipc=VS.IPC[item.ipc4761]||VS.IPC.none;
      field(s,"IPC-4761",ipc.id,v=>change(()=>{if(v==="none"){delete item.ipc4761;delete item.ipcSides;}else item.ipc4761=v;}),{values:Object.values(VS.IPC).map(t=>[t.id,t.label])});
      if(ipc.sided)field(s,"Applies to",item.ipcSides||"both",v=>change(()=>{item.ipcSides=v;}),{values:[["both","Both sides (-b)"],["top","Top only (-a)"],["bottom","Bottom only (-a)"]]});
      for(const side of ["top","bottom"]){
        const t=item.tent?.[side],covered=ipc.covered&&(!ipc.sided||(item.ipcSides||"both")==="both"||item.ipcSides===side);
        const sel=field(s,side==="top"?"Top mask":"Bottom mask",typeof t==="boolean"?(t?"tented":"open"):"",v=>change(()=>{item.tent={...(item.tent||{})};if(!v)delete item.tent[side];else item.tent[side]=v==="tented";if(!Object.keys(item.tent).length)delete item.tent;}),
          {values:[["","Output default"],["tented","Tented"],["open","Open"]]});
        if(covered){sel.disabled=true;sel.title="IPC-4761 "+VS.ipcCode(item)+" covers this side";}
      }
      check("Via-in-pad",item.viaInPad,on=>change(()=>{if(on)item.viaInPad=true;else delete item.viaInPad;}));
      // Back-drill: remove the unused barrel stub.
      const bd=item.backdrill;
      check("Back-drill",!!bd,on=>change(()=>{if(on)item.backdrill={from:"bottom",toLayer:keys[Math.max(0,keys.length-3)]||keys[0],stubMax:.2};else delete item.backdrill;}));
      if(bd){
        const setBd=patch=>change(()=>{item.backdrill={...item.backdrill,...patch};});
        field(s,"Drill from",bd.from||"bottom",v=>setBd({from:v}),{values:[["bottom","Bottom"],["top","Top"]]});
        field(s,"Keep to",bd.toLayer||keys[0],v=>setBd({toLayer:v}),{values:keys});
        field(s,unitLabel("Max stub"),bd.stubMax??.2,v=>setBd({stubMax:v}),{length:true,min:0});
        field(s,unitLabel("Tool ⌀"),bd.diameter??null,v=>change(()=>{item.backdrill={...item.backdrill};if(v==null)delete item.backdrill.diameter;else item.backdrill.diameter=v;}),{length:true,min:.001,allowEmpty:true}).placeholder="Drill + oversize";
      }
      // What the fab will see: rings, aspect ratio and any problem, under the values.
      const r=VS.validate(item,d,{defs,project});
      const bad=r.messages.filter(m=>m.level!=="info");
      if(bad.length)for(const m of bad)s.append(el("p",m.text,m.level==="error"?"side-note ui-prop-error":"side-note"));
      else row(s,"Rings",(r.rings.filter(x=>x.ring!=null).map(x=>ctx.len(x.ring)).join(" · ")||"—")+(Number.isFinite(r.aspect)?" · "+r.aspect.toFixed(1)+":1":""));
      const more=globalThis.AtriumNavHost.ui.button("Cross-section…",()=>globalThis.AtriumNavHost.act("viaStack"));more.title="The via drawn through the layer stack, with a land shape per layer";s.append(more);
    }
    function inspectMulti(panel, section) {
      const d = ctx.doc(), ids = ctx.selection(), info = sharedFields(d, ids);
      if (info.kinds.size > 1) {
        // Kind chips: narrow the selection to one kind, as Altium's selection filter chips.
        const chips = el("div", null, "ui-chips pcb-edit-chips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Narrow selection to one kind");
        for (const [kind, n] of info.kinds) chips.append(button(kindLabel(kind) + " (" + n + ")", () => ctx.select(info.items.filter(i => i.kind === kind).map(i => i.id)), "ui-chip pcb-edit-chip"));
        section.append(chips);
        lockToggle(section, info.items);
        return true;
      }
      const s = globalThis.AtriumNavHost.ui.section(panel, kindLabel(info.kind) + " · " + info.items.length);
      const apply = (key, value, values) => {
        const touched = new Set(info.items);
        const macros = info.kind === "track" && key === "width" && globalThis.AtriumMacros;
        const before = macros ? new Map(info.items.map(item => [item.id, item.width])) : null;
        const accepted = ctx.edit(() => applyField(d, ctx.project(), ids, key, value, ctx.defs(), {values, touched}), undefined,
          () => [{doc:d, items:touched, library:key === "side"}]);
        if (macros && accepted !== false) {
          const unlocked = info.items.filter(item => !item.locked);
          const groups = new Map();
          for (const item of unlocked) if (item.width !== before.get(item.id)) {
            if (!groups.has(item.width)) groups.set(item.width, []);
            groups.get(item.width).push(item.id);
          }
          for (const [width, changed] of groups) {
            const wholeSelection = groups.size === 1 && unlocked.length === info.items.length &&
              unlocked.every(item => item.width === width);
            const args = wholeSelection ? {width} : {width, ids:changed};
            macros.recordCurrent("butter.macros.set-track-width", args, {changed:changed.length}, "write");
          }
        }
      };
      const commit = (key, value) => {
        // Side and rotation move placed parts: locked parts ask first.
        if ((key === "side" || key === "angle") && !guardLocked(ids, key === "side" ? "Flip" : "Rotate", () => commit(key, value))) return;
        const chk = ruleCheck(ctx.doc(), ctx.project(), ids, key, value);
        if (chk.issues.length) ruleDialog(chk, () => apply(key, value), () => apply(key, value, chk.values)); else apply(key, value);
      };
      for (const f of info.fields) {
        if (f.type === "side" && !ctx.pcb()) continue;
        if (f.type === "bool") { lockToggle(s, info.items); continue; }
        const l = el("label", null, "field-row"), mixed = f.value === VARIES;
        let input;
        if (f.type === "layer" || f.type === "anylayer" || f.type === "side") {
          input = el("select");
          const values = f.type === "side" ? ["Top", "Bottom"] : f.type === "layer" ? ctx.layers() : [...new Set([...ctx.layers(), "Silk", "Bottom silk", "Mechanical", ...info.items.map(i => i.layer).filter(Boolean)])];
          if (mixed) input.add(new Option("<varies>", ""));
          for (const v of values) input.add(new Option(ctx.layerName?.(v) || v, v));
          input.value = mixed ? "" : f.value;
          input.onchange = () => { if (input.value) commit(f.key, input.value); };
        } else {
          input = el("input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
          if(f.type==="length" || f.type==="number") {
            const length=f.type==="length",unit=length ? ctx.unit() : f.key==="angle" ? "deg" : "";
            input.inputMode="decimal";
            globalThis.AtriumLazy?.numericField?.(input,{unit,storageUnit:length?"mm":unit,nanometres:length,min:length ? .000001 : undefined});
          }
          input.placeholder = mixed ? "<varies>" : "";
          input.value = mixed || f.value == null ? "" : String(f.type === "length" && ctx.unitValue ? ctx.unitValue(f.value) : f.value);
          input.onchange = () => {
            const t = input.value.trim();
            if (f.type === "text") { commit(f.key, t); return; }
            if (!t) return;
            const v = f.type === "length" ? ctx.parseLength(t) : Number(t);
            if (!Number.isFinite(v) || f.type === "length" && v <= 0) { ctx.info("Enter a length such as 0.25mm or 10mil."); input.value = ""; return; }
            commit(f.key, v);
          };
        }
        input.setAttribute("aria-label", f.label);
        l.append(el("span", f.type === "length" ? f.label + " (" + ctx.unit() + ")" : f.label), input); s.append(l);
      }
      return true;
    }
    // Warn before a multi-edit breaks design rules; offer to clamp each object to its rule.
    function ruleDialog(chk, anyway, clamp) {
      const dlg = el("dialog", null, "ui-dialog message-dialog pcb-edit-rules"); dlg.setAttribute("aria-label", "Design rule check");
      const first = chk.issues[0], n = new Set(chk.issues.map(i => i.id)).size;
      const title = el("h2", "Below design rules", "ui-dialog-title");
      const body = el("p", plural(n, "object") + " would break " + (first.rule ? "the " + first.rule + " rule" : "a design rule") + ": " + first.what + " " + ctx.len(first.actual) + (first.limit === "min" ? " is below the minimum " : " is above the maximum ") + ctx.len(first.required) + (chk.issues.length > 1 ? " (and " + plural(chk.issues.length - 1, "more", "more") + ")" : "") + ".", "ui-dialog-body");
      const cancel = button("Cancel", () => { dlg.close(); ctx.inspect(); });
      const fit = button("Clamp to rules", () => { dlg.close(); clamp(); });
      const go = button("Apply anyway", () => { dlg.close(); anyway(); });
      const actions = el("div", null, "ui-dialog-actions");
      for (const action of [cancel, fit, go]) action.classList.add("ui-button");
      fit.dataset.variant = "primary";
      go.dataset.variant = "danger";
      actions.append(cancel, fit, go);
      dlg.append(title, body, actions);
      document.body.append(dlg);
      dlg.addEventListener("close", () => dlg.remove(), {once: true});
      globalThis.AtriumShell?.adoptDialog?.(dlg, {initialFocus: fit});
      dlg.showModal(); fit.focus();
    }
    // ---------- Find Similar (shared dialog; this adapter keeps board field semantics)
    function findSimilarDialog() {
      const d = ctx.doc(), defs = ctx.defs(), item = d.items.find(i => i.id === ctx.primary()) || d.items.find(i => ctx.selection().has(i.id));
      const fmt = p => typeof p.value === "number" && ["width", "diameter", "drill", "w", "h", "size"].includes(p.key) ? ctx.len(p.value) : typeof p.value === "boolean" ? (p.value ? "Yes" : "No") : String(p.value === "" ? "—" : p.value);
      globalThis.AtriumFindSimilarDialog.open(ctx, {
        kind: () => d.kind,
        item: () => item,
        fields: () => similarProps(d, defs, item).filter(p => p.key !== "kind").map(p => ({key: p.key, label: p.label, text: fmt(p)})),
        initial: p => p.key === "footprint" || p.key === "layer" && item.kind !== "track" ? "same" : "any",
        match: (choice, within) => findSimilar(d, defs, item, choice, {within, selectable: i => ctx.selectable(i)}),
        summary: ids => ids.length + " matching " + (LABELS[item.kind] || item.kind).toLowerCase() + ".",
        commit(ids, zoom) {
          ctx.select(ids, item.id);
          if (zoom) ctx.zoomTo?.(ids);
          ctx.info(ids.length + " similar objects selected. Edit them together in Properties.");
        },
      });
    }

    // ---------- snap popover (status bar)
    function snapPopover(anchor) {
      const old = document.querySelector(".pcb-edit-snap-pop");
      old?.dispatchEvent(new Event("dismiss-snap"));
      const pop = el("div", null, "pcb-edit-snap-pop ui-popover"); pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Snap options");
      pop.dataset.anchor = "bottom";
      const row = (key, label) => { const l = el("label", null, "pcb-edit-check"), b = el("input", null, "ui-checkbox"); b.type = "checkbox"; b.checked = snapPrefs[key]; b.onchange = () => { changeSnap(key, b.checked); if (key === "grid") ctx.setGridSnap?.(b.checked); }; l.append(b, el("span", " " + label)); pop.append(l); return b; };
      pop.append(el("strong", "Snap"));
      row("grid", "Snap to grid");
      const objects = row("objects", "Snap to objects");
      const K = globalThis.AtriumKeymap, key = K?.hintKey("snap-object", "pcb");
      if (key) {
        const badge = AtriumShortcut.render(key, {variant:"inline"});
        badge.setAttribute("aria-hidden", "true");
        objects.nextElementSibling.append(" ", badge);
      }
      globalThis.AtriumNavCommon?.shortcutTitle(objects, "Snap to objects", key);
      pop.append(el("small", "Object hotspots"));
      row("pads", "Pad centres"); row("vias", "Via centres"); row("tracks", "Track vertices"); row("outline", "Board outline vertices");
      const r = el("label", null, "pcb-edit-check"), n = el("input", null, "ui-field"); n.type = "number"; n.min = "2"; n.max = "40"; n.value = String(snapPrefs.radius); n.setAttribute("aria-label", "Snap distance in pixels");
      n.onchange = () => {changeSnap("radius", n.value); n.value = String(snapPrefs.radius);}; r.append(el("span", "Distance (px) "), n); pop.append(r);
      document.body.append(pop);
      const b = anchor?.getBoundingClientRect?.(); if (b) { pop.style.left = Math.max(4, b.left) + "px"; pop.style.bottom = (innerHeight - b.top + 6) + "px"; }
      const listeners = new AbortController(), surface = globalThis.AtriumSurfaceMotion;
      function close(instant = false) {
        listeners.abort();
        if (surface) surface.popover(pop, false, {instant, done:() => pop.remove()});
        else pop.remove();
      }
      document.addEventListener("pointerdown", e => {
        if (!pop.contains(e.target) && e.target !== anchor) close();
      }, {capture:true, signal:listeners.signal});
      pop.addEventListener("dismiss-snap", () => close(true), {once:true});
      pop.addEventListener("keydown", e => { if (e.key === "Escape") { close(); anchor?.focus?.(); } });
      pop.querySelector("input")?.focus();
      surface?.popover(pop, true, {instant:!!old});
    }
    return {inspectItem, inspectMulti, findSimilarDialog, snapPopover};
  }
  return {install};
})();
