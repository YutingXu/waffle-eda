"use strict";
// Paste Special, Paste Array and Rubber Stamp (Edit menu; rubber stamp Ctrl/⌘+R), on
// schematics and boards. They place the editor clipboard through the editor's paste tool,
// so the copies float on the cursor until a click.
//
//   AtriumPasteSpecial.build(project, doc, clip, defs, options) -> a paste plan
//     options: {designators:"reannotate"|"keep"|"increment", labels:"keep"|"increment",
//               step:1, keepNets:true, count:1, dx:0, dy:0}
// A plan is what AtriumEditSelection.prepare returns ({items, defs, bounds, commit(at)}):
// items are relative to the click point, commit adds them and returns their ids. Copy k
// (0-based) of an array sits at (k·dx, k·dy) and steps its names by (k + 1)·step.
globalThis.AtriumPasteSpecial = (() => {
  const LABEL_KINDS = new Set(["netlabel", "port", "offsheet"]);
  const sig = def => {const {id, ...rest} = def || {}; return JSON.stringify(rest);};
  const step = (t, n) => globalThis.AtriumSchPlace ? AtriumSchPlace.increment(t, n) : String(t).replace(/(\d+)$/, d => String(Math.max(0, +d + n)));
  function nextFree(name, used, n = 1) {
    let t = String(name || "U1"); if (!/\d$/.test(t)) t += "1";
    for (let guard = 0; used.has(t.toUpperCase()) && guard < 100000; guard++) t = step(t, n > 0 ? n : 1);
    return t;
  }
  function build(project, doc, clip, defs, o = {}) {
    const ES = globalThis.AtriumEditSelection, A = globalThis.Atrium;
    if (!clip?.items?.length) throw Error("Copy or cut objects first, then paste them.");
    const count = Math.max(1, Math.min(500, Math.round(+o.count || 1))), inc = Number.isFinite(+o.step) && +o.step ? Math.round(+o.step) : 1;
    const mode = o.designators || "reannotate", dx = +o.dx || 0, dy = +o.dy || 0;
    const fresh = {...clip, cut:false}, copies = [];
    for (let k = 0; k < count; k++) copies.push(ES.prepare(project, doc, fresh, defs));
    // Definitions new to this project: every copy uses the first copy's.
    const first = copies[0], firstNew = new Map();
    for (const [id, d] of first.defs) if (!defs.has(id)) firstNew.set(sig(d), id);
    const used = new Set();
    for (const d of project.documents) for (const i of d.items) if (i.kind === "part" && i.ref && !(doc.kind === "pcb" && d.kind !== "pcb")) used.add(i.ref.toUpperCase());
    const items = [];
    copies.forEach((sub, k) => {
      sub.items.forEach((item, j) => {
        const src = clip.items[j];
        if (k && item.kind === "part" && !defs.has(item.def)) {const id = firstNew.get(sig(sub.defs.get(item.def))); if (id) item.def = id;}
        if (item.kind === "part" && src?.ref) {
          if (mode === "keep") item.ref = src.ref;
          else if (mode === "increment") item.ref = nextFree(step(src.ref, (k + 1) * inc), used, inc);
          else item.ref = nextFree((/^(.*?)\d+$/.exec(src.ref)?.[1] ?? src.ref.replace(/\?$/, "")) + "1", used);
          used.add(item.ref.toUpperCase());
        }
        if (o.labels === "increment" && LABEL_KINDS.has(item.kind) && typeof item.text === "string") item.text = step(src?.text ?? item.text, (k + 1) * inc);
        if (o.keepNets === false) {
          if (item.kind === "part" && item.pinNets) item.pinNets = {};
          if (typeof item.net === "string") item.net = "";
        }
        if (k && (dx || dy)) A.moveItem(item, k * dx, k * dy);
        items.push(item);
      });
    });
    const planDefs = first.defs;
    return {items, defs:planDefs, bounds:A.docBounds({...doc, outline:[], items}, planDefs), copies:count, commit(at) {
      first.commit(at);
      for (const sub of copies.slice(1)) for (const item of sub.items) {A.moveItem(item, at[0], at[1]); doc.items.push(item);}
      return items.map(i => i.id);
    }};
  }

  // ------------------------------------------------------------------ editor glue
  const H = () => globalThis.AtriumNavHost;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  let last = {designators:"reannotate", labels:"keep", step:1, keepNets:true, count:4, dx:null, dy:0};
  function clipboard() {
    const clip = H()?.clipboard?.();
    if (!clip) {H()?.info("Copy or cut objects first, then paste them.");return null;}
    if (clip.kind !== H().doc().kind) {H().info("The clipboard holds " + (clip.kind === "pcb" ? "board" : "schematic") + " objects: paste them into a " + (clip.kind === "pcb" ? "board layout." : "schematic sheet."));return null;}
    return clip;
  }
  function start(o, stamp = false) {
    const h = H(), clip = clipboard();
    if (!clip) return;
    const make = () => build(h.project(), h.doc(), clip, h.defs(), o);
    try {
      const plan = make();
      if (stamp) plan.again = () => {try {const p = make(); p.again = plan.again; return p;} catch (e) {h.info(e.message); return null;}};
      h.placePlan(plan);
      h.info(stamp ? "Rubber stamp: click to place a copy, again for the next; Escape or right-click ends." :
        "Click to place " + (plan.copies > 1 ? plan.copies + " copies (" + plan.items.length + " objects)." : plan.items.length + (plan.items.length === 1 ? " object." : " objects.")));
    } catch (e) {h.info(e.message);}
  }
  function dialog(array) {
    const h = H(), clip = clipboard();
    if (!clip) return;
    const unit = h.units?.() || "mm", U = Atrium.units, grid = h.doc().grid || 1;
    const d = el("dialog", null, "message-dialog ps-dialog"); d.setAttribute("aria-label", array ? "Paste Array" : "Paste Special");
    const form = el("form"), title = el("h2", array ? "Paste Array" : "Paste Special");
    form.method = "dialog"; form.append(title);
    const row = (label, input) => {const l = el("label", null, "ps-row"); l.append(el("span", label), input); input.setAttribute("aria-label", label); form.append(l); return input;};
    const select = (label, value, options) => {const s = el("select"); for (const [v, t] of options) s.add(new Option(t, v)); s.value = value; return row(label, s);};
    const text = (label, value) => {const i = el("input"); i.type = "text"; i.value = value; i.autocomplete = "off"; return row(label, i);};
    const pcb = h.doc().kind === "pcb";
    const des = select("Designators", last.designators, [["reannotate", "Re-annotate (next free)"], ["keep", "Keep original"], ["increment", "Increment by step"]]);
    const labels = pcb ? null : select("Net labels and ports", last.labels, [["keep", "Keep names"], ["increment", "Increment by step"]]);
    const inc = text("Text increment", String(last.step));
    const keepNets = el("input"); keepNets.type = "checkbox"; keepNets.checked = last.keepNets !== false; if (pcb) row("Keep net names", keepNets);
    let count, dx, dy;
    if (array) {
      count = text("Count", String(last.count));
      dx = text("X spacing (" + unit + ")", U.value(last.dx ?? grid * (pcb ? 20 : 8), unit));
      dy = text("Y spacing (" + unit + ")", U.value(last.dy || 0, unit));
    }
    const note = el("p", "", "side-note ps-note"); form.append(note);
    const ok = el("button", array ? "Place array" : "Paste", "is-primary"); ok.type = "submit";
    const cancel = el("button", "Cancel"); cancel.type = "button"; cancel.onclick = () => d.close();
    const actions = el("div", null, "work-actions"); actions.append(cancel, ok);
    form.append(actions); d.append(form); document.body.append(d);
    d.onclose = () => d.remove();
    form.onsubmit = e => {
      e.preventDefault();
      const o = {designators:des.value, labels:labels?.value || "keep", step:Math.round(+inc.value) || 1, keepNets:pcb ? keepNets.checked : true};
      if (array) {
        o.count = Math.round(+count.value); o.dx = U.parse(dx.value, unit); o.dy = U.parse(dy.value, unit);
        if (!(o.count >= 1 && o.count <= 500)) {note.textContent = "Enter a count from 1 to 500."; return;}
        if (!Number.isFinite(o.dx) || !Number.isFinite(o.dy)) {note.textContent = "Enter the spacing as a length, such as 10mm or 400mil."; return;}
      }
      last = {...last, ...o};
      d.close(); start(o);
    };
    globalThis.AtriumShell?.adoptDialog?.(d, {title, body:form, actions, initialFocus:des});
    d.showModal(); des.focus();
  }
  function install(h) {
    h.registerAction("paste-special", () => dialog(false));
    h.registerAction("paste-array", () => dialog(true));
    h.registerAction("rubber-stamp", () => start({designators:"reannotate", labels:"keep", keepNets:true}, true));
  }
  if (globalThis.AtriumNavHost) install(globalThis.AtriumNavHost);
  return Object.freeze({build, install});
})();
