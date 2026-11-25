"use strict";
// Related components (Altium "Related Components"): a library part names its alternates (parts
// that can replace it) and its associated hardware (heatsinks, sockets, screws, mating
// connectors: parts fitted with it). Design › Library › Related Components…, MCP
// related_components. Stored on the library part (format 1.3), optional:
//   def.related = [{kind:"alternate"|"associated", def?, mpn?, manufacturer?, qty?, note?}]
// An entry names a library part (def, by id) or an orderable part (mpn). qty is per placed part
// (associated hardware only). Older builds keep the field unchanged (unknown part fields stay).
globalThis.AtriumRelated = (() => {
  const KINDS = ["alternate", "associated"], MAX = 50;
  const KIND_NAMES = {alternate: "Alternate", associated: "Associated hardware"};
  const fail = m => { throw Error(m); };
  const str = (v, n) => typeof v === "string" && v.length <= n && !/[\u0000-\u001f]/.test(v);
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const libOf = p => Array.isArray(p?.library) ? p.library : fail("The project has no library.");
  const defOf = (p, id) => libOf(p).find(d => d.id === id || d.name === id) || fail("The library has no part " + id + ".");
  // A clean copy of one entry; throws on anything unexpected.
  function clean(e, p, owner) {
    if (!plain(e)) fail("A related component must be an object.");
    for (const k of Object.keys(e)) if (!["kind", "def", "mpn", "manufacturer", "qty", "note"].includes(k)) fail("A related component has the unsupported setting " + k + ".");
    if (!KINDS.includes(e.kind)) fail("A related component is an alternate or associated hardware.");
    const out = {kind: e.kind};
    if (e.def != null) {
      if (!str(e.def, 256) || !e.def) fail("A related component names a library part by its ID.");
      if (p) { const d = defOf(p, e.def); if (d.id === owner) fail("A part cannot be related to itself."); out.def = d.id; } else out.def = e.def;
    }
    if (e.mpn != null && e.mpn !== "") { if (!str(e.mpn, 120)) fail("The part number is too long."); out.mpn = e.mpn.trim(); }
    if (!out.def && !out.mpn) fail("A related component needs a library part or a manufacturer part number.");
    if (e.manufacturer != null && e.manufacturer !== "") { if (!str(e.manufacturer, 120)) fail("The manufacturer name is too long."); out.manufacturer = e.manufacturer.trim(); }
    if (e.qty != null) { if (e.kind !== "associated" || !Number.isInteger(e.qty) || e.qty < 1 || e.qty > 1000) fail("Associated hardware takes a whole quantity from 1 to 1000."); out.qty = e.qty; }
    if (e.note != null && e.note !== "") { if (!str(e.note, 500)) fail("The note is too long."); out.note = e.note; }
    return out;
  }
  function validate(list, p, owner) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > MAX) fail("A part has at most " + MAX + " related components.");
    const out = list.map(e => clean(e, p, owner)), seen = new Set();
    for (const e of out) { const k = e.kind + "|" + (e.def || "") + "|" + (e.mpn || "").toLowerCase(); if (seen.has(k)) fail("A related component is listed twice."); seen.add(k); }
    return out;
  }
  const label = (p, e) => { const d = e.def ? libOf(p).find(x => x.id === e.def) : null; return (d ? d.name : e.def || "") + (e.mpn ? (d || e.def ? " · " : "") + (e.manufacturer ? e.manufacturer + " " : "") + e.mpn : ""); };
  function list(p, id) {
    const d = defOf(p, id);
    return (Array.isArray(d.related) ? d.related : []).map((e, index) => ({index, ...e, label: label(p, e), missing: !!e.def && !libOf(p).some(x => x.id === e.def)}));
  }
  function set(p, id, entries) {
    const d = defOf(p, id), next = validate(entries, p, d.id);
    if (next.length) d.related = next; else delete d.related;
    return d;
  }
  const add = (p, id, e) => set(p, id, [...(defOf(p, id).related || []), e]);
  function remove(p, id, index) {
    const cur = [...(defOf(p, id).related || [])];
    if (!(index >= 0 && index < cur.length)) fail("No related component at that position.");
    cur.splice(index, 1);
    return set(p, id, cur);
  }
  // Parts that list this one as related (the reverse view: "used as alternate for …").
  const usedBy = (p, id) => libOf(p).filter(d => (d.related || []).some(e => e.def === id)).map(d => ({def: d.id, name: d.name, kinds: [...new Set(d.related.filter(e => e.def === id).map(e => e.kind))]}));
  // Associated hardware a board needs: per library part placed, qty × placements.
  function hardware(p, doc) {
    const count = new Map();
    for (const i of doc?.items || []) if (i.kind === "part" && i.def) count.set(i.def, (count.get(i.def) || 0) + 1);
    const out = [];
    for (const [defId, n] of count) {
      const d = libOf(p).find(x => x.id === defId);
      for (const e of d?.related || []) if (e.kind === "associated") out.push({for: d.name, item: label(p, e), def: e.def || null, mpn: e.mpn || null, qty: n * (e.qty || 1), ...(e.note ? {note: e.note} : {})});
    }
    return out;
  }
  // MCP related_components: {op: list|add|remove|set|hardware, part, entry?, entries?, index?, document_id?}
  function headless(p, a = {}, docOf) {
    const op = a.op || "list";
    if (op === "hardware") { const doc = docOf ? docOf(p, a, "pcb") : null; return {document_id: doc?.id || null, hardware: hardware(p, doc)}; }
    if (!a.part) fail("Name the library part (part).");
    if (op === "add") add(p, a.part, a.entry || fail("Give the entry to add."));
    else if (op === "remove") remove(p, a.part, a.index);
    else if (op === "set") set(p, a.part, a.entries || []);
    else if (op !== "list") fail("Unknown operation " + op + ".");
    const d = defOf(p, a.part);
    return {part: d.id, name: d.name, related: list(p, d.id).map(({index, label, missing, ...e}) => ({...e, label, ...(missing ? {missing} : {})})), used_by: usedBy(p, d.id)};
  }

  // ---------------------------------------------------------------- dialog
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, variant, title) { const b = el("button", text, "ui-button"); b.type = "button"; b.onclick = act; if (variant) b.dataset.variant = variant; if (title) b.title = title; return b; }
  function open(host) {
    const p = host.project(), doc = host.doc(), sel = new Set(host.selection?.() || []);
    const placed = (doc?.items || []).find(i => sel.has(i.id) && i.kind === "part");
    let current = placed?.def || p.library[0]?.id || null;
    document.querySelectorAll("dialog.related-components-dialog").forEach(x => x.close());
    const d = el("dialog", null, "work-dialog ui-dialog related-components-dialog", {"aria-label": "Related components"});
    const field = (label, input) => {
      const row = el("label", null, "related-components-field ui-field-row");
      input.classList.add("ui-field");
      row.append(el("span", label), input);
      return row;
    };
    const pick = el("select", null, null, {"aria-label": "Library part"});
    for (const x of [...p.library].sort((a, b) => String(a.name).localeCompare(String(b.name)))) pick.add(new Option(x.name, x.id));
    pick.value = current || "";
    pick.onchange = () => { current = pick.value; paint(); };
    const rows = el("div", null, "rel-rows"), back = el("p", null, "rel-back"), status = el("p", null, "rel-status", {role: "status", "aria-live": "polite"});
    const say = t => { status.textContent = t; };
    const kind = el("select", null, null, {"aria-label": "Kind"}); for (const k of KINDS) kind.add(new Option(KIND_NAMES[k], k));
    const lib = el("select", null, null, {"aria-label": "Related library part"}); lib.add(new Option("— part number only —", ""));
    for (const x of p.library) lib.add(new Option(x.name, x.id));
    const mpn = el("input", null, null, {type: "text", maxlength: "120", placeholder: "MPN", "aria-label": "Manufacturer part number"});
    const mfr = el("input", null, null, {type: "text", maxlength: "120", placeholder: "Manufacturer", "aria-label": "Manufacturer"});
    const qty = el("input", null, null, {type: "number", min: "1", max: "1000", step: "1", value: "1", "aria-label": "Quantity per part"});
    const note = el("input", null, null, {type: "text", maxlength: "500", placeholder: "Note", "aria-label": "Note"});
    const syncQty = () => { qty.disabled = kind.value !== "associated"; }; kind.onchange = syncQty; syncQty();
    const form = el("fieldset", null, "related-components-form", {"aria-label":"Related component to add"});
    const addActions = el("div", null, "related-components-add");
    addActions.append(button("Add", () => {
      try {
        const e = {kind: kind.value, ...(lib.value ? {def: lib.value} : {}), mpn: mpn.value, manufacturer: mfr.value, note: note.value, ...(kind.value === "associated" ? {qty: Math.max(1, Math.round(+qty.value || 1))} : {})};
        host.edit(() => add(p, current, e));
        mpn.value = mfr.value = note.value = ""; lib.value = ""; paint(); say("Added.");
      } catch (err) { say(err.message); }
    }, "primary"));
    form.append(field("Kind",kind),field("Related library part",lib),field("Manufacturer part number",mpn),
      field("Manufacturer",mfr),field("Quantity per part",qty),field("Note",note),addActions);
    function paint() {
      rows.replaceChildren(); back.textContent = "";
      if (!current) { rows.append(el("p", "The library is empty.")); return; }
      const items = list(p, current);
      if (!items.length) rows.append(el("p", "No alternates or associated hardware yet.", "rel-empty"));
      for (const k of KINDS) {
        const mine = items.filter(e => e.kind === k);
        if (!mine.length) continue;
        rows.append(el("h3", KIND_NAMES[k]));
        for (const e of mine) {
          const r = el("div", null, "rel-row");
          r.append(el("span", e.label + (e.qty > 1 ? " × " + e.qty : "") + (e.missing ? " (not in the library)" : "")), el("span", e.note || "", "rel-note"),
            button("Remove", () => { try { host.edit(() => remove(p, current, e.index)); paint(); say("Removed."); } catch (err) { say(err.message); } }, "", "Remove this related component"));
          rows.append(r);
        }
      }
      const by = usedBy(p, current);
      if (by.length) back.textContent = "Listed as related by: " + by.map(b => b.name + " (" + b.kinds.map(k => KIND_NAMES[k].toLowerCase()).join(", ") + ")").join(", ");
    }
    const head = el("h2", "Related Components", "ui-dialog-title");
    const foot = el("div", null, "work-actions"); foot.append(button("Close", () => d.close()));
    d.append(head, field("Library part",pick), el("p", "Alternates can replace this part; associated hardware is fitted with it (heatsinks, sockets, screws, mating connectors).", "rel-help"), rows, back, form, status, foot);
    d.addEventListener("close", () => d.remove(), {once: true});
    globalThis.AtriumShell?.adoptDialog?.(d, {title:head, body:[rows,back,form,status], actions:foot, initialFocus:pick});
    document.body.append(d); paint(); d.showModal(); pick.focus();
    return d;
  }
  function install(host) { host.registerAction?.("related-components", () => open(host)); }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);
  return Object.freeze({KINDS, validate, list, set, add, remove, usedBy, hardware, headless, open});
})();
