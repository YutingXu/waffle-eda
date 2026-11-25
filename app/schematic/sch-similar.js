"use strict";
// Find Similar Objects on schematics (Shift+F, Edit › Find Similar Objects…, right-click on a part,
// wire, net label, port or power port). Lazy: app/lazy.js loads it for the "find-similar" action
// on a schematic, and pcb-edit.js hands the action here. The dialog is
// app/editor/find-similar-dialog.js; matching stays here. The board matcher stays in pcb-edit.js.
//
// As on the board, every property of the reference object is listed with Same / Different / Any.
// The object kind always matches. Properties by kind:
//   part        Library reference, Comment, Value, Footprint, Designator prefix, Sheet
//   pin         Name, Number, Electrical type, Net, Library reference (of its part), Sheet
//   wire / bus  Net, Sheet
//   net label, port, off-sheet connector, power port
//               Net (the name it gives), Style or I/O type, Sheet
//   other       Text, Sheet
// Sheet decides the search scope: Same (default) searches this sheet, Any all schematic sheets,
// Different the other sheets. Matches on other sheets are listed by sheet; Select selects the
// matches on this sheet (or opens the first sheet that has matches).
//
// Pins are part of their symbol and are not selectable on their own, so pin matching selects the
// parts that own the matching pins and reports the pin count.
//
// API (pure, used by the dialog and the headless find_similar command):
//   props(project, doc, defs, item, {pin})            -> [{key, label, value}]
//   find(project, doc, defs, item, criteria, o)       -> [{doc, id, pin?}]   o: {pin, within, selectable}
//   open(ctx)                                         -> shows the dialog (ctx: pcb-edit's editor context)
globalThis.AtriumSchSimilar = (() => {
  const A = () => globalThis.Atrium;
  const LABELS = {part:"Components", pin:"Pins", wire:"Wires", bus:"Buses", netlabel:"Net labels", power:"Power ports", port:"Ports", offsheet:"Off-sheet connectors",
    junction:"Junctions", text:"Texts", label:"Texts", sheetsymbol:"Sheet symbols", busentry:"Bus entries", noerc:"No ERC markers", graphic:"Drawing objects"};
  const NAMED = new Set(["netlabel", "power", "port", "offsheet"]);
  // Pin electrical types (pin.electrical, as library-panel.js and the symbol editor store it; default Passive).
  const ELECTRICAL = ["Input", "I/O", "Output", "Open Collector", "Passive", "HiZ", "Open Emitter", "Power"];

  // ------------------------------------------------------------------ nets (one connectivity pass per sheet and run)
  function netCache() {
    const m = new Map();
    return (doc, defs) => {
      if (!m.has(doc)) { let cn = null; try { cn = A().connectivity(doc, defs); } catch {} m.set(doc, cn || {byPin: new Map(), byWire: new Map()}); }
      return m.get(doc);
    };
  }
  function netOf(item, doc, defs, nets) {
    if (item.kind === "wire") return nets(doc, defs).byWire.get(item.id) || item.net || "";
    if (item.kind === "bus") return item.net || item.text || "";
    if (NAMED.has(item.kind)) return String(item.text ?? "");
    return undefined;
  }
  const pinsOf = (part, defs) => { const def = defs.get(part.def); try { return def ? A().pins(part, def, "schematic") : []; } catch { return []; } };
  const pinNet = (part, pin, doc, defs, nets) => nets(doc, defs).byPin.get(part.id + "/" + pin.number) || "";
  const parameter = (part, def, name) => {
    for (const src of [part.parameters, def?.parameters]) if (src) for (const [k, v] of Object.entries(src)) if (k.toLowerCase() === name) return String(v ?? "");
    return undefined;
  };

  // ------------------------------------------------------------------ properties
  function values(item, doc, defs, nets, pin) {
    const def = item.kind === "part" ? defs.get(item.def) : null, out = [["kind", "Object", pin ? "pin" : item.kind]];
    const add = (key, label, value) => { if (value !== undefined) out.push([key, label, value]); };
    if (pin) {
      add("pinName", "Pin name", String(pin.name ?? "")); add("pinNumber", "Pin number", String(pin.number ?? ""));
      add("pinType", "Electrical type", ELECTRICAL[pin.electrical ?? 4] || String(pin.electrical));
      add("net", "Net", pinNet(item, pin, doc, defs, nets)); add("libRef", "Library reference", def?.name || "");
    } else switch (item.kind) {
      case "part":
        add("libRef", "Library reference", def?.name || ""); add("value", "Comment", String(item.value ?? ""));
        add("paramValue", "Value", parameter(item, def, "value"));
        add("footprint", "Footprint", def?.footprint?.name || ""); add("prefix", "Designator prefix", String(item.ref || "").replace(/\d.*$/, ""));
        break;
      case "wire": case "bus": add("net", "Net", netOf(item, doc, defs, nets)); break;
      case "power": add("net", "Net", netOf(item, doc, defs, nets)); add("style", "Style", item.style || "bar"); break;
      case "port": add("net", "Net", netOf(item, doc, defs, nets)); add("io", "I/O type", item.io || "unspecified"); break;
      case "netlabel": case "offsheet": add("net", "Net", netOf(item, doc, defs, nets)); break;
      default: if (item.text !== undefined || item.name !== undefined) add("text", "Text", String(item.text ?? item.name ?? ""));
    }
    add("sheet", "Sheet", doc.name || "");
    return out;
  }
  function props(project, doc, defs, item, o = {}) {
    const nets = netCache(), pin = o.pin != null && item.kind === "part" ? pinsOf(item, defs).find(p => String(p.number) === String(o.pin)) : null;
    if (o.pin != null && !pin) throw Error("Part " + (item.ref || item.id) + " has no pin " + o.pin + ".");
    return values(item, doc, defs, nets, pin).map(([key, label, value]) => ({key, label, value}));
  }

  /** criteria: {key: "same"|"different"|"any"}; sheet defaults to "same". Returns [{doc, id, pin?}]. */
  function find(project, doc, defs, item, criteria = {}, o = {}) {
    const nets = netCache();
    const pin = o.pin != null && item.kind === "part" ? pinsOf(item, defs).find(p => String(p.number) === String(o.pin)) : null;
    if (o.pin != null && !pin) throw Error("Part " + (item.ref || item.id) + " has no pin " + o.pin + ".");
    const reference = values(item,doc,defs,nets,pin).filter(([key])=>key!=="kind" && key!=="sheet").map(([key,,value])=>({key,value}));
    const sheet = criteria.sheet || "same";
    const sheets = (project?.documents || [doc]).filter(d => d.kind === "schematic" && (sheet === "any" || (sheet === "same") === (d === doc || d.id === doc.id)));
    const scope = o.within ? new Set(o.within) : null, ok = o.selectable || (() => true), out = [];
    const match = A().similarProperties(reference,criteria), pass = vals => match(key=>vals.get(key));
    for (const d of sheets) for (const i of d.items) {
      if (scope && !(d === doc && scope.has(i.id))) continue;
      if (pin) {
        if (i.kind !== "part" || !ok(i)) continue;
        for (const q of pinsOf(i, defs)) if (pass(new Map(values(i, d, defs, nets, q).map(([k, , v]) => [k, v])))) out.push({doc: d.id, id: i.id, pin: String(q.number)});
        continue;
      }
      if (i.kind !== item.kind || !ok(i)) continue;
      if (pass(new Map(values(i, d, defs, nets, null).map(([k, , v]) => [k, v])))) out.push({doc: d.id, id: i.id});
    }
    return out;
  }

  // ------------------------------------------------------------------ dialog (shared; this adapter keeps sheet field semantics)
  function open(ctx) {
    const project = ctx.project(), d = ctx.doc(), defs = ctx.defs();
    const item = d.items.find(i => i.id === ctx.primary()) || d.items.find(i => ctx.selection().has(i.id));
    let pin = null;
    const name = () => item.kind === "part" ? "part " + (item.ref || "") : (LABELS[item.kind] || item.kind).toLowerCase().replace(/s$/, "");
    function split(hits) {
      const here = hits.filter(h => h.doc === d.id), other = new Map();
      for (const h of hits) if (h.doc !== d.id) other.set(h.doc, (other.get(h.doc) || 0) + 1);
      return {here, other};
    }
    const sheetName = id => project?.documents.find(x => x.id === id)?.name || id;
    globalThis.AtriumFindSimilarDialog.open(ctx, {
      shape: "sheet",
      kind: () => d.kind,
      item: () => item,
      preface: () => "Reference: " + (pin ? "pin " + pin + " of " + (item.ref || "part") : name()) + " on " + (d.name || "this sheet") + ".",
      lead(api) {
        if (item.kind !== "part") return [];
        const pins = pinsOf(item, defs);
        if (!pins.length) return [];
        const K = globalThis.AtriumUIKit;
        const sel = K.select([["", "This part"], ...pins.slice(0, 500).map(q => [String(q.number), "Pin " + q.number + (q.name && q.name !== String(q.number) ? " · " + q.name : "")])], {
          value: pin || "",
          label: "Match the part or one of its pins",
          onChange(value) { pin = value || null; api.rebuild(); },
        });
        const row = K.el("label", "work-row");
        row.append(K.el("span", null, "Match "), sel);
        return [row];
      },
      // Defaults: this sheet; a part matches its library reference and footprint; a pin its name.
      fields: () => props(project, d, defs, item, {pin}).filter(p => p.key !== "kind").map(p => ({
        key: p.key, label: p.label, text: p.value === "" ? "—" : String(p.value),
      })),
      initial: p => p.key === "sheet" || (pin ? p.key === "pinName" : p.key === "libRef" || p.key === "footprint") ? "same" : "any",
      match: (choice, within) => find(project, d, defs, item, choice, {pin, within, selectable: i => ctx.selectable ? ctx.selectable(i) : true}),
      summary(hits) {
        const {here, other} = split(hits);
        const what = pin ? "pin" : (LABELS[item.kind] || item.kind).toLowerCase().replace(/s$/, "");
        let text = here.length + " matching " + what + (here.length === 1 ? "" : "s") + " on this sheet";
        if (pin) text += " (" + new Set(here.map(h => h.id)).size + " parts)";
        if (other.size) text += " · " + (hits.length - here.length) + " on other sheets (" + [...other].map(([id, n]) => sheetName(id) + " " + n).join(", ") + ")";
        return text + ".";
      },
      commit(hits, zoom) {
        const {here, other} = split(hits);
        let ids = [...new Set(here.map(h => h.id))], where = d.id;
        if (!ids.length && other.size) { where = [...other.keys()][0]; ids = [...new Set(hits.filter(h => h.doc === where).map(h => h.id))]; }
        if (where !== d.id) ctx.selectDocument?.(where);
        ctx.select(ids, ids.includes(item.id) ? item.id : ids[0] || null);
        if (zoom && ids.length) ctx.zoomTo?.(ids);
        const rest = hits.filter(h => h.doc !== where).length;
        ctx.info(ids.length + (pin ? " parts with matching pins" : " similar objects") + " selected" + (where !== d.id ? " on " + sheetName(where) : "") +
          (rest ? "; " + rest + " more on other sheets" : "") + ". Edit them together in Properties.");
      },
    });
  }
  return Object.freeze({props, find, open, LABELS});
})();
