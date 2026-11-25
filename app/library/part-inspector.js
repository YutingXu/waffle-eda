"use strict";

// Part inspector additions (PARITY §3.2 #10). editor.js inspect() builds the part's
// section (footprint, designator, value, position; pcb-edit adds side and lock; the
// schematic Parameters panel comes from sch-objects). This module fills the gaps that an
// Altium user expects in the same section: designator and comment visibility, the
// library link, pad count, 3D body height and, on boards, the component's parameters.
// Rows and the Parameters disclosure come from the Properties panel's helpers (AtriumNavHost.ui),
// so labels and values share one column and the disclosure remembers whether it was open.
globalThis.AtriumPartInspector = (() => {
  const LENGTH = /^(?:\d+\.?\d*|\.\d+)\s*(?:mm|mils?|thou|th|in|inch(?:es)?|"|µm|μm|um|cm)?$/i;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  function check(parent, label, checked, update) {
    const l = el("label", null, "field-row part-check"), box = el("input");
    box.type = "checkbox"; box.checked = checked; box.setAttribute("aria-label", label);
    box.onchange = () => update(box.checked);
    l.append(el("span", label), box); parent.append(l); return box;
  }
  // 3D body height, as step-export reads it: part.height, then the definition's.
  function bodyHeight(part, def) {
    for (const v of [part.height, part.model3d?.height, def?.height, def?.footprint?.height]) {
      const n = typeof v === "number" ? v : parseFloat(v);
      if (Number.isFinite(n) && n > 0) return {mm: n, own: v === part.height};
    }
    return null;
  }
  function lengthField(parent, label, mm, ctx, update, placeholder, target) {
    const U = globalThis.Atrium?.units, unit = ctx.unit || "mm";
    const l = el("label", null, "field-row"), f = el("input");
    f.type = "text"; f.inputMode = "decimal"; f.autocomplete = "off"; f.spellcheck = false; f.dataset.unit = unit;
    globalThis.AtriumLazy?.numericField?.(f,{unit,storageUnit:"mm",nanometres:true,min:1e-6,max:1000,optional:true,target});
    f.value = mm == null ? "" : String(U ? U.value(mm, unit) : mm);
    if (placeholder) f.placeholder = placeholder;
    f.title = "Value in " + unit + ". Suffixes such as mil, mm or in are accepted. Leave empty to use the library value.";
    f.setAttribute("aria-label", label);
    f.onchange = () => {
      const text = f.value.trim();
      if (!text) { update(null); return; }
      const v = U ? U.parse(text, unit) : Number(text);
      if (!LENGTH.test(text) || !Number.isFinite(v) || v <= 0 || v > 1000) {
        f.value = mm == null ? "" : String(U ? U.value(mm, unit) : mm);
        ctx.info?.("Enter a height such as 1.2mm or 50mil, or leave it empty to use the library value.");
        return;
      }
      update(v);
    };
    l.append(el("span", label), f); parent.append(l); return f;
  }
  const paramNames = (part, def) => [...new Set([...Object.keys(def?.parameters || {}), ...Object.keys(part.parameters || {})])].filter(k => !/^(DESIGNATOR|COMMENT)$/i.test(k));
  // The schematic's Parameters grid (sch-object-inspector.js), read-only: Show, Name, Value.
  function paramGrid(body, part, def, ctx) {
    const names = paramNames(part, def), own = part.parameters || {}, lib = def?.parameters || {};
    if (names.length) {
      const table = el("div", null, "sch-param-grid sch-param-readonly");
      table.append(el("span", "Show", "sch-param-head"), el("span", "Name", "sch-param-head"), el("span", "Value", "sch-param-head"), el("span", ""));
      for (const k of names) {
        const show = el("input"), value = el("input");
        show.type = "checkbox"; show.checked = part.paramShow?.[k] === true; show.disabled = true; show.setAttribute("aria-label", "Show " + k + " on the sheet");
        value.value = String(Object.hasOwn(own, k) ? own[k] : lib[k] ?? ""); value.readOnly = true; value.setAttribute("aria-label", k + " value");
        if (!Object.hasOwn(own, k)) value.classList.add("sch-param-inherited");
        table.append(show, el("span", k, "sch-param-name"), value, el("span", ""));
      }
      body.append(table);
    } else body.append(el("p", "No parameters yet. Add MPN, manufacturer and other BOM fields from the component on the schematic.", "empty-state"));
    const go = el("button", "Edit on Sheet ↗"); go.type = "button";
    globalThis.AtriumUI?.button(go, "secondary");
    go.title = "Cross-probe to this component on the schematic, where its parameters are edited";
    go.onclick = () => (ctx.act || globalThis.AtriumNavHost?.act)?.("cross-probe");
    body.append(go);
    return body;
  }
  function extend(section, part, def, ctx) {
    const ui = ctx.ui || globalThis.AtriumNavHost?.ui;
    if (!section || part?.kind !== "part" || !ui) return;
    const row = ui.row, edit = fn => ctx.edit(() => fn(part)), pcb = !!ctx.pcb;
    check(section, "Show designator", part.showRef !== false, on => edit(p => { if (on) delete p.showRef; else p.showRef = false; }));
    check(section, "Show comment", part.showValue !== false, on => edit(p => { if (on) delete p.showValue; else p.showValue = false; }));
    const lib = def ? (def.library || def.source || def.libraryName || (def.builtin || def.id?.startsWith?.("std-") ? "Waffle standard parts" : "Project library")) : "Missing from the library";
    row(section, "Library", typeof lib === "string" ? lib : "Project library").title = def ? "Library component: " + def.name : "This part's library component is missing.";
    if (pcb) {
      const pads = def?.footprint?.pads?.length || 0;
      row(section, "Pads", String(pads));
      const h = bodyHeight(part, def), U = globalThis.Atrium?.units;
      lengthField(section, "3D height (" + (ctx.unit || "mm") + ")", h?.own ? h.mm : null, ctx,
        v => edit(p => { if (v == null) delete p.height; else p.height = v; }),
        h && !h.own ? String(U ? U.value(h.mm, ctx.unit || "mm") : h.mm) + " (library)" : "Library value",
        {scope:"item",documentId:globalThis.AtriumNavHost?.currentId?.(),itemId:part.id,path:["height"]});
      // Parameters are edited on the schematic (its Parameters grid); the board shows the same
      // grid read-only, so BOM fields are visible while placing, and Edit on Sheet cross-probes.
      ui.disclosure(section, "Parameters (" + paramNames(part, def).length + ")", body => paramGrid(body, part, def, ctx));
      section.lastElementChild.classList.add("part-params");
    }
    if (def?.generic || part.resolvedFrom) globalThis.AtriumLazy?.need("AtriumGenericPartsUI").then(U => section.isConnected && U.inspect(section, part, def, ctx), () => {}); // generic parts, placeholders
  }
  return {extend, bodyHeight, paramGrid};
})();
