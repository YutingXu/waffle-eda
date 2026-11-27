"use strict";

// Sheet symbols, sheet entries and free text open a form only when their placement needs input.
globalThis.AtriumSchObjectForms = (() => {
  // A small modal form. fields: [{key,label,value,options?,type?}]. Resolves values or null.
  function ask(ctx, title, fields, {quick = null, note = ""} = {}) {
    const {el, button} = ctx;
    return new Promise(resolve => {
      const d = el("dialog", null, "message-dialog sch-ask"); d.setAttribute("aria-label", title);
      const form = el("form"); form.method = "dialog"; form.append(el("h2", title));
      if (note) form.append(el("p", note, "side-note"));
      const inputs = {};
      let settled = false;
      // Settle directly from the buttons; the close event (Escape) only cancels.
      const done = value => {
        if (settled) return; settled = true;
        if (d.open) d.close();
        d.remove(); resolve(value); ctx?.canvas?.focus?.();
      };
      if (quick) {
        const row = el("div", null, "sch-quick");
        for (const q of quick) {const b = button(q.label, () => done(q.values)); b.title = q.title || q.label; row.append(b);}
        form.append(row);
      }
      for (const f of fields) {
        const l = el("label", null, "field-row"); l.append(el("span", f.label));
        let input;
        if (f.options) {input = el("select"); for (const [v, t] of f.options) input.add(new Option(t, v));}
        else if (f.type === "textarea") {input = el("textarea"); input.rows = 4;}
        else {input = el("input"); input.type = f.type || "text"; input.autocomplete = "off"; input.spellcheck = false;}
        if (f.required) {input.required = true; input.pattern = ".*\\S.*";}
        if (f.maxLength) input.maxLength = f.maxLength;
        if (f.type === "checkbox") input.checked = !!f.value; else input.value = f.value ?? "";
        input.setAttribute("aria-label", f.label); inputs[f.key] = input; l.append(input); form.append(l);
      }
      const ok = el("button", "OK", "is-primary"); ok.type = "submit";
      const actions = el("div", null, "work-actions"); actions.append(button("Cancel", () => done(null)), ok);
      form.append(actions); d.append(form); document.body.append(d);
      form.onsubmit = e => {
        e.preventDefault(); const result = {};
        for (const [k, input] of Object.entries(inputs)) result[k] = input.type === "checkbox" ? input.checked : input.value.trim();
        done(result);
      };
      d.onclose = () => done(null);
      const initialFocus = Object.values(inputs)[0] || d.querySelector("button");
      globalThis.AtriumShell?.adoptDialog?.(d, {title:form.firstElementChild, body:form, actions, initialFocus});
      d.showModal(); initialFocus?.focus();
    });
  }
  async function sheetSymbol(c, begin) {
    const doc = c.doc(), project = c.project(), A = globalThis.Atrium;
    const others = project.documents.filter(d => d.kind === "schematic" && d.id !== doc.id);
    const r = await ask(c, "Place sheet symbol", [
      {key:"name", label:"Designator", value:"U_" + (others[0]?.name || "Sheet").replace(/\s+/g, "_")},
      {key:"sheet", label:"Child sheet", value:others[0]?.id || "*new", options:[...others.map(d => [d.id, d.name]), ["*new", "New sheet…"]]},
      {key:"newName", label:"New sheet name", value:"Sheet " + (project.documents.filter(d => d.kind === "schematic").length + 1)}
    ], {note:"Use Repeat(CH,1,4) as the designator for a multi-channel symbol. Entries are created from the child sheet's ports."});
    if (!r) return;
    let child = project.documents.find(d => d.id === r.sheet);
    if (r.sheet === "*new" || !child) {
      child = A.sheet("schematic", r.newName || "Sheet");
      c.edit(() => c.project().documents.push(child));
    }
    begin("sheetsymbol", {name:r.name || "U_" + child.name, sheet:child.id}, "Click to place the sheet symbol for " + child.name + ".");
  }
  async function sheetEntry(ctx, p) {
    const doc = ctx.doc(), A = globalThis.Atrium;
    const {edgeAt, portsOf, IO, fitSymbol, entryPort} = globalThis.AtriumSchObjects;
    const tol = 6 / (ctx.view?.scale?.() || 4);
    const symbol = doc.items.filter(i => i.kind === "sheetsymbol").find(i => {const e = edgeAt(i, p); return e.distance <= Math.max(tol, .3) && p[0] >= i.x - tol && p[0] <= i.x + i.w + tol && p[1] >= i.y - tol && p[1] <= i.y + i.h + tol;});
    if (!symbol) {ctx.info("Click on the border of a sheet symbol."); return;}
    const where = edgeAt(symbol, p), child = ctx.project().documents.find(d => d.id === symbol.sheet);
    const free = portsOf(child).filter(q => !symbol.entries.some(e => entryPort(e.name) === q.name));
    const r = await ask(ctx, "Add sheet entry", [
      {key:"name", label:"Name", value:free[0]?.name || "ENTRY"},
      {key:"io", label:"I/O type", value:free[0]?.io || "unspecified", options:IO.map(v => [v, v[0].toUpperCase() + v.slice(1)])}
    ], {note:free.length ? "Child ports without an entry: " + free.map(q => q.name).join(", ") : "Name the entry after a port on " + (child?.name || "the child sheet") + "."});
    if (!r?.name) return;
    if (symbol.entries.some(e => e.side === where.side && Math.abs(e.offset - where.offset) < 1e-6)) {ctx.info("An entry already sits there."); return;}
    ctx.edit(() => {symbol.entries.push({id:A.id(), name:r.name, side:where.side, offset:where.offset, io:IO.includes(r.io) ? r.io : "unspecified"}); fitSymbol(symbol, {doc, defs:ctx.defs?.()});});
    ctx.info("Entry " + r.name + " added to " + symbol.name + ".");
  }
  return {ask, sheetSymbol, sheetEntry};
})();
