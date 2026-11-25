"use strict";
// Netlists: export and import (File › Import › Netlist…, File › Export › … Netlist…, MCP export_netlist / import_netlist).
// Lazy: app/lazy.js loads this file on the first use of one of its actions.
//
//   AtriumNetlist.extract(project, {source, board})  -> {source, document, components, nets, issues}
//       source "schematic" (compiled sheets, hierarchy-aware), "pcb" (pad nets of a board) or "auto"
//   AtriumNetlist.kicad(netlist, {name, date})       -> KiCad netlist text (.net, s-expression, version "E")
//   AtriumNetlist.protel(netlist)                    -> Protel-style netlist text ([ component ] and ( net ) blocks)
//   AtriumNetlist.csv(netlist)                       -> "Net,Designator,Pin,Pin Name" CSV
//   AtriumNetlist.parse(text, {format})              -> {format, components, nets, issues}; format auto, kicad, protel or csv
//   AtriumNetlist.importInto(project, parsed, o)     -> adds a placeholder schematic sheet (and a board if there is none)
//       whose parts carry net labels on their pins, so the existing ECO (Update PCB Document) creates the footprints
//       and pad nets. Returns {sheet_id, board_id, components, nets, labels, defs_added, issues}.
//
// Why a placeholder sheet: Waffle keeps board footprints linked to schematic parts. A netlist imported straight into a
// board would leave every footprint "without a schematic link", and the next Update PCB would offer to remove them. The
// sheet is the netlist drawn as parts with net labels: Update PCB, ERC, cross-probing and later netlist imports keep
// working, and the user can redraw it by hand.
//
// Clean-room. The formats are written from public descriptions only: the KiCad netlist is an s-expression
// (export (version) (design) (components (comp (ref) (value) (footprint) …)) (libparts …) (nets (net (code) (name)
// (node (ref) (pin) …)))); the Protel netlist lists components as "[ designator / footprint / comment ]" blocks and
// nets as "( name / REF-PIN … )" blocks. No code from another program was used.
globalThis.AtriumNetlist = (() => {
  const A = globalThis.Atrium;
  const fail = m => { throw Error(m); };
  const up = s => String(s ?? "").trim().toUpperCase();
  const collator = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}) : null;
  const cmp = (a, b) => collator ? collator.compare(String(a ?? ""), String(b ?? "")) : String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
  const annotated = r => !!String(r || "").trim() && !/[?*]/.test(r);
  const TYPES = ["input", "bidirectional", "output", "open_collector", "passive", "tri_state", "open_emitter", "power_in"];
  // KiCad pin types -> Waffle electrical types (library-panel.js ELECTRICAL order).
  const ELECTRICAL_OF = {input: 0, bidirectional: 1, output: 2, open_collector: 3, passive: 4, tri_state: 5, open_emitter: 6, power_in: 7, power_out: 7};
  const MAX_TEXT = 32 << 20, MAX_COMPONENTS = 20000, MAX_NODES = 400000;

  // ---------------------------------------------------------------- extract
  const electricalName = p => TYPES[globalThis.AtriumERC?.pinType?.(p) ?? p?.electrical] || "passive";
  const footprintName = d => String(d?.footprint?.name || d?.footprintName || "").trim();
  function extract(p, o = {}) {
    const defs = o.defs || new Map(p.library.map(d => [d.id, d])), issues = [];
    const sheets = p.documents.filter(d => d.kind === "schematic");
    const boards = p.documents.filter(d => d.kind === "pcb");
    let source = o.source || "auto";
    if (source === "auto") source = sheets.some(s => s.items.some(i => i.kind === "part")) ? "schematic" : "pcb";
    const comps = new Map();
    const comp = (ref, init) => { let c = comps.get(up(ref)); if (!c) comps.set(up(ref), c = {ref: String(ref).trim(), pins: new Map(), ...init}); return c; };
    let document = null;
    if (source === "schematic") {
      if (!sheets.length) fail("The project has no schematic sheet.");
      document = null;
      let hier = o.hierarchy || null;
      if (!hier) try { hier = globalThis.AtriumHierarchy?.compile(p, {defs}) || null; } catch { hier = null; }
      for (const inst of hier?.instances || sheets.map(doc => ({doc}))) {
        const sheet = inst.doc, graph = hier?.byInstance?.get(inst.id) || A.connectivity(sheet, defs);
        for (const i of sheet.items) {
          if (i.kind !== "part") continue;
          if (!annotated(i.ref)) { issues.push(sheet.name + " / " + (i.ref || "(no designator)") + " is not annotated and is left out."); continue; }
          const d = defs.get(i.def);
          if (!d?.symbol) continue;
          const ref = inst.designator ? inst.designator(i) : i.ref + (inst.suffix || "");
          o.onPart?.(ref, sheet, i);
          const c = comp(ref, {value: i.value ?? d.value ?? "", footprint: footprintName(d), part: d.name || "", description: d.description || "",
            parameters: i.parameters || null, def: d.id});
          for (const pin of A.pins(i, d, "schematic")) {
            const n = String(pin.number ?? "");
            if (!n) continue;
            const net = graph.byPin.get(i.id + "/" + n) || "";
            const had = c.pins.get(n);
            if (!had || (!had.net && net)) c.pins.set(n, {number: n, name: pin.name || "", type: electricalName(pin), net});
          }
        }
      }
    } else {
      const board = o.board != null ? boards.find(b => b.id === o.board || up(b.name) === up(o.board)) : boards[0];
      if (!board) fail(o.board != null ? "No board is called " + o.board + "." : "The project has no board layout.");
      document = board.id;
      for (const i of board.items) {
        if (i.kind !== "part" || !annotated(i.ref)) continue;
        const d = defs.get(i.def);
        if (comps.has(up(i.ref))) { issues.push("Duplicate board designator " + i.ref + "; only the first is listed."); continue; }
        o.onPart?.(i.ref, board, i);
        const c = comp(i.ref, {value: i.value ?? d?.value ?? "", footprint: footprintName(d), part: d?.name || "", description: d?.description || "",
          parameters: i.parameters || null, def: d?.id || null});
        const names = new Map((d?.symbol?.pins || []).map(x => [String(x.number), x]));
        for (const pad of d?.footprint?.pads || []) {
          // A pad with no number is still a node (Altium writes "U1-"): an exposed pad on GND, say.
          // Footprint-owned vias and thermal vias are not.
          if (pad.kind === "via" || pad.thermalVia) continue;
          const n = String(pad.number ?? ""), had = c.pins.get(n);
          const own = i.pinNets && Object.prototype.hasOwnProperty.call(i.pinNets, n);
          const sym = names.get(n), net = (own ? i.pinNets[n] : pad.net) || "";
          if (!had || (!had.net && net)) c.pins.set(n, {number: n, name: sym?.name || "", type: electricalName(sym), net});
        }
      }
    }
    const components = [...comps.values()].sort((a, b) => cmp(a.ref, b.ref)).map(c => ({...c, pins: [...c.pins.values()].sort((a, b) => cmp(a.number, b.number))}));
    const byNet = new Map();
    for (const c of components) for (const pin of c.pins) if (pin.net) {
      if (!byNet.has(pin.net)) byNet.set(pin.net, []);
      byNet.get(pin.net).push({ref: c.ref, pin: pin.number, name: pin.name, type: pin.type});
    }
    const nets = [...byNet.keys()].sort(cmp).map((name, k) => ({code: k + 1, name, nodes: byNet.get(name).sort((a, b) => cmp(a.ref, b.ref) || cmp(a.pin, b.pin))}));
    return {source, document, name: p.name || "", components, nets, issues};
  }

  // ---------------------------------------------------------------- KiCad (s-expression)
  const q = s => "\"" + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n") + "\"";
  function kicad(n, o = {}) {
    const out = ["(export (version \"E\")", "  (design", "    (source " + q(o.name || n.name || "Waffle") + ")"];
    if (o.date) out.push("    (date " + q(o.date) + ")");
    out.push("    (tool \"Waffle\"))", "  (components");
    const libparts = new Map();
    for (const c of n.components) {
      out.push("    (comp (ref " + q(c.ref) + ")", "      (value " + q(c.value) + ")");
      if (c.footprint) out.push("      (footprint " + q(c.footprint) + ")");
      const part = c.part || c.ref.replace(/\d.*$/, "") || "Part";
      out.push("      (libsource (lib \"atrium\") (part " + q(part) + ") (description " + q(c.description || "") + "))");
      for (const [k, v] of Object.entries(c.parameters || {}).sort((a, b) => cmp(a[0], b[0]))) out.push("      (property (name " + q(k) + ") (value " + q(v) + "))");
      out[out.length - 1] += ")";
      if (!libparts.has(part)) libparts.set(part, c);
    }
    out[out.length - 1] += ")";
    out.push("  (libparts");
    for (const [part, c] of [...libparts].sort((a, b) => cmp(a[0], b[0]))) {
      out.push("    (libpart (lib \"atrium\") (part " + q(part) + ")");
      if (c.footprint) out.push("      (footprints (fp " + q(c.footprint) + "))");
      out.push("      (pins");
      for (const pin of c.pins) out.push("        (pin (num " + q(pin.number) + ") (name " + q(pin.name || pin.number) + ") (type " + q(pin.type || "passive") + "))");
      out[out.length - 1] += "))";
    }
    out[out.length - 1] += ")";
    out.push("  (nets");
    for (const net of n.nets) {
      out.push("    (net (code " + q(net.code) + ") (name " + q(net.name) + ")");
      for (const x of net.nodes) out.push("      (node (ref " + q(x.ref) + ") (pin " + q(x.pin) + ")" + (x.name ? " (pinfunction " + q(x.name) + ")" : "") + " (pintype " + q(x.type || "passive") + "))");
      out[out.length - 1] += ")";
    }
    out[out.length - 1] += "))";
    return out.join("\n") + "\n";
  }
  // A small s-expression reader: lists, bare atoms and double-quoted strings with backslash escapes.
  function sexpr(text) {
    const root = [], stack = [root];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (ch === "(") { const l = []; stack[stack.length - 1].push(l); stack.push(l); if (stack.length > 200) fail("The netlist is nested too deeply."); i++; }
      else if (ch === ")") { if (stack.length < 2) fail("The netlist has an unbalanced \")\"."); stack.pop(); i++; }
      else if (ch === "\"") {
        let s = "", j = i + 1;
        for (; j < n && text[j] !== "\""; j++) {
          if (text[j] === "\\" && j + 1 < n) { j++; s += text[j] === "n" ? "\n" : text[j]; } else s += text[j];
        }
        if (j >= n) fail("The netlist has an unterminated string.");
        stack[stack.length - 1].push({s}); i = j + 1;
      } else if (/\s/.test(ch)) i++;
      else { let j = i; while (j < n && !/[\s()"]/.test(text[j])) j++; stack[stack.length - 1].push({s: text.slice(i, j)}); i = j; }
    }
    if (stack.length !== 1) fail("The netlist has an unbalanced \"(\".");
    return root;
  }
  const head = l => Array.isArray(l) && l[0] && !Array.isArray(l[0]) ? l[0].s : null;
  const kids = (l, name) => Array.isArray(l) ? l.filter(x => head(x) === name) : [];
  const kid = (l, name) => kids(l, name)[0] || null;
  const val = (l, name) => { const k = kid(l, name); return k && k[1] && !Array.isArray(k[1]) ? k[1].s : ""; };
  function parseKicad(text, decision) {
    const tree = sexpr(text), root = tree.find(x => head(x) === "export") || fail("Not a KiCad netlist: no (export …) list.");
    const issues = [], pinInfo = new Map();
    for (const lp of kids(kid(root, "libparts"), "libpart")) {
      const key = val(lp, "lib") + ":" + val(lp, "part"), pins = new Map();
      for (const pin of kids(kid(lp, "pins"), "pin")) pins.set(val(pin, "num"), {name: val(pin, "name"), type: val(pin, "type")});
      pinInfo.set(key, pins);
    }
    const components = [];
    for (const c of kids(kid(root, "components"), "comp")) {
      const src = kid(c, "libsource"), parameters = {};
      for (const pr of kids(c, "property")) { const k = val(pr, "name"); if (k) parameters[k] = val(pr, "value"); }
      // Older netlists list fields as (fields (field (name "MPN") "value")).
      for (const f of kids(kid(c, "fields"), "field")) { const k = val(f, "name"), v = f.find((x, i) => i > 0 && !Array.isArray(x)); if (k && v) parameters[k] = v.s; }
      components.push({ref: val(c, "ref"), value: val(c, "value"), footprint: val(c, "footprint"), part: src ? val(src, "part") : "",
        description: src ? val(src, "description") : "", parameters, libkey: src ? val(src, "lib") + ":" + val(src, "part") : ""});
    }
    const nets = [];
    for (const net of kids(kid(root, "nets"), "net")) {
      const nodes = kids(net, "node").map(x => ({ref: val(x, "ref"), pin: val(x, "pin"), name: val(x, "pinfunction"), type: val(x, "pintype")}));
      nets.push({code: val(net, "code"), name: val(net, "name"), nodes});
    }
    // Pin names and types from the node lists, then from the library parts.
    const byRef = new Map(components.map(c => [up(c.ref), c]));
    for (const c of components) c.pins = new Map();
    for (const net of nets) for (const x of net.nodes) {
      const c = byRef.get(up(x.ref));
      if (!c) { issues.push("Net " + net.name + " names " + x.ref + ", which is not in the component list."); continue; }
      c.pins.set(x.pin, {number: x.pin, name: x.name || "", type: x.type || "", net: net.name});
    }
    for (const c of components) for (const [num, info] of pinInfo.get(c.libkey) || []) {
      const had = c.pins.get(num);
      if (had) { if (!had.name && info.name && info.name !== "~") had.name = info.name; if (!had.type) had.type = info.type; }
      else c.pins.set(num, {number: num, name: info.name === "~" ? "" : info.name, type: info.type, net: ""});
    }
    return finishParsed("kicad", components, nets, issues, decision);
  }

  // ---------------------------------------------------------------- Protel ([ component ] and ( net ) blocks)
  function protel(n) {
    const out = [];
    for (const c of n.components) out.push("[", c.ref, c.footprint || "", c.value || "", "", "", "", "]");
    for (const net of n.nets) { out.push("(", net.name); for (const x of net.nodes) out.push(x.ref + "-" + x.pin); out.push(")"); }
    return out.join("\r\n") + "\r\n";
  }
  function parseProtel(text, decision) {
    const lines = text.split(/\r\n|\r|\n/), components = [], nets = [], issues = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === "[") {
        const block = [], start = i + 1;
        for (i++; i < lines.length && lines[i].trim() !== "]"; i++) block.push(lines[i].trim());
        if (i >= lines.length) fail("A component block ([) is not closed.");
        if (!block[0]) {
          const reason = "A component block has no designator; it is skipped.";
          issues.push(reason); decision?.("Component","dropped","line " + start,reason);
        }
        else components.push({ref: block[0], footprint: block[1] || "", value: block[2] || "", parameters: {}});
        i++;
      } else if (t === "(") {
        const block = [];
        for (i++; i < lines.length && lines[i].trim() !== ")"; i++) if (lines[i].trim()) block.push(lines[i].trim());
        if (i >= lines.length) fail("A net block (() is not closed.");
        nets.push({name: block[0] || "", raw: block.slice(1)});
        i++;
      } else if (!t || t.startsWith("{") || t.startsWith(";")) i++;
      else fail("Not a Protel netlist: line " + (i + 1) + " is outside a [ ] or ( ) block.");
    }
    // A node is REF-PIN; designators may contain "-", so the longest known designator wins.
    const refs = components.map(c => c.ref).sort((a, b) => b.length - a.length);
    for (const net of nets) {
      net.nodes = [];
      for (const raw of net.raw) {
        const ref = refs.find(r => raw.length > r.length + 1 && up(raw.slice(0, r.length)) === up(r) && raw[r.length] === "-");
        if (ref) { net.nodes.push({ref, pin: raw.slice(ref.length + 1)}); continue; }
        const k = raw.lastIndexOf("-");
        const reason = k <= 0 ? "Net " + net.name + ": " + raw + " is not REF-PIN; it is skipped." :
          "Net " + net.name + " names " + raw.slice(0, k) + ", which is not in the component list.";
        issues.push(reason); decision?.("Pin connection","dropped",net.name + "/" + raw,reason);
      }
      delete net.raw;
    }
    for (const c of components) c.pins = new Map();
    const byRef = new Map(components.map(c => [up(c.ref), c]));
    for (const net of nets) for (const x of net.nodes) byRef.get(up(x.ref)).pins.set(x.pin, {number: x.pin, name: "", type: "", net: net.name});
    return finishParsed("protel", components, nets, issues, decision);
  }

  // ---------------------------------------------------------------- CSV
  function csvCell(v) { const s = String(v ?? ""); return /[",\r\n]/.test(s) || /^[=+\-@\t\r]/.test(s) ? "\"" + (/^[=+\-@\t\r]/.test(s) ? "'" : "") + s.replace(/"/g, "\"\"") + "\"" : s; }
  function csv(n) {
    const rows = [["Net", "Designator", "Pin", "Pin Name"]];
    for (const net of n.nets) for (const x of net.nodes) rows.push([net.name, x.ref, x.pin, x.name || ""]);
    return rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  function csvRows(text) {
    const rows = [];
    let row = [], cell = "", quoted = false, i = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quoted) { if (ch === "\"" && text[i + 1] === "\"") { cell += "\""; i++; } else if (ch === "\"") quoted = false; else cell += ch; }
      else if (ch === "\"") quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function parseCsv(text, decision) {
    const rows = csvRows(text), header = rows.findIndex(r => r.some(c => c.trim()));
    const h = (rows[header] || []).map(s => s.trim().toLowerCase()), issues = [];
    const col = names => h.findIndex(x => names.includes(x));
    const cn = col(["net", "net name"]), cr = col(["designator", "ref", "reference", "component"]), cp = col(["pin", "pin number", "pad"]), cpn = col(["pin name", "pinname"]);
    if (cn < 0 || cr < 0 || cp < 0) fail("The CSV needs Net, Designator and Pin columns.");
    const clean = s => String(s ?? "").trim().replace(/^'(?=[=+\-@\t])/, "");
    const comps = new Map(), byNet = new Map();
    for (let i = header + 1; i < rows.length; i++) {
      const r = rows[i], net = clean(r[cn]), ref = clean(r[cr]), pin = clean(r[cp]);
      if (!net || !ref || !pin) {
        if (decision && r.some(c => c.trim())) decision("Pin connection","dropped","CSV record " + (i + 1),"A net, designator and pin are required.");
        continue;
      }
      let c = comps.get(up(ref));
      if (!c) comps.set(up(ref), c = {ref, footprint: "", value: "", parameters: {}, pins: new Map()});
      c.pins.set(pin, {number: pin, name: cpn >= 0 ? clean(r[cpn]) : "", type: "", net});
      if (!byNet.has(net)) byNet.set(net, []);
      byNet.get(net).push({ref: c.ref, pin});
    }
    return finishParsed("csv", [...comps.values()], [...byNet].map(([name, nodes]) => ({name, nodes})), issues, decision);
  }

  function finishParsed(format, components, nets, issues, decision) {
    function issue(kind, status, object, reason) { issues.push(reason); decision?.(kind,status,object,reason); }
    if (components.length > MAX_COMPONENTS) fail("The netlist has more than " + MAX_COMPONENTS + " components.");
    if (nets.reduce((s, n) => s + n.nodes.length, 0) > MAX_NODES) fail("The netlist has more than " + MAX_NODES + " pin connections.");
    const seen = new Set(), list = [];
    for (const [index,c] of components.entries()) {
      if (!c.ref) { issue("Component","dropped","component[" + index + "]","A component has no designator; it is skipped."); continue; }
      if (/\s/.test(c.ref)) { issue("Component","dropped",c.ref,"Designator \"" + c.ref + "\" contains spaces; it is skipped."); continue; }
      if (seen.has(up(c.ref))) { issue("Component","dropped","component[" + index + "] " + c.ref,"Designator " + c.ref + " is listed twice; the first is kept."); continue; }
      seen.add(up(c.ref));
      list.push({ref: c.ref, value: c.value || "", footprint: c.footprint || "", part: c.part || "", description: c.description || "", parameters: c.parameters || {},
        pins: [...(c.pins || new Map()).values()].sort((a, b) => cmp(a.number, b.number))});
    }
    const byName = new Map();
    for (const [index,n] of nets.entries()) {
      if (!n.name) { issue("Net","dropped","net[" + index + "]","A net has no name; it is skipped."); continue; }
      let target = byName.get(n.name);
      if (target) issue("Net","approximated","net[" + index + "] " + n.name,"Net " + n.name + " is listed twice; its nodes are merged.");
      else { target = {name:n.name,nodes:[]}; byName.set(n.name,target); }
      for (const x of n.nodes) {
        if (seen.has(up(x.ref))) target.nodes.push(x);
        else decision?.("Pin connection","dropped",n.name + "/" + x.ref + "/" + x.pin,"The designator has no imported component.");
      }
    }
    const outNets = [...byName.values()];
    // A pin on two nets is a netlist error: the first net keeps it.
    const owner = new Map();
    for (const n of outNets) n.nodes = n.nodes.filter(x => {
      const k = up(x.ref) + "\u0000" + x.pin, o = owner.get(k);
      if (o && o !== n.name) { issue("Pin connection","dropped",n.name + "/" + x.ref + "/" + x.pin,x.ref + " pin " + x.pin + " is on " + o + " and " + n.name + "; it stays on " + o + "."); return false; }
      owner.set(k, n.name); return true;
    });
    outNets.sort((a, b) => cmp(a.name, b.name));
    list.sort((a, b) => cmp(a.ref, b.ref));
    return {format, components: list, nets: outNets, issues};
  }
  function detect(text) {
    const t = String(text).replace(/^﻿/, "").trimStart();
    if (t.startsWith("(export")) return "kicad";
    if (t.startsWith("[") || /^\(\s*[\r\n]/.test(t)) return "protel";
    if (/^[^\r\n]*\bnet\b[^\r\n]*,[^\r\n]*\b(designator|ref|reference|component)\b/i.test(t)) return "csv";
    return null;
  }
  function parse(text, o = {}) {
    if (typeof text !== "string") fail("The netlist must be text.");
    if (text.length > MAX_TEXT) fail("The netlist is larger than 32 MB.");
    text = text.replace(/^﻿/, "");
    const format = !o.format || o.format === "auto" ? detect(text) || fail("This is not a KiCad (.net), Protel or CSV netlist.") : o.format;
    if (format === "kicad") return parseKicad(text,o.decision);
    if (format === "protel") return parseProtel(text,o.decision);
    if (format === "csv") return parseCsv(text,o.decision);
    fail("Unknown netlist format " + format + ".");
  }

  // ---------------------------------------------------------------- import (placeholder sheet + ECO)
  const G = 2.54, r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const fpKey = s => up(String(s || "").replace(/^.*:/, ""));
  // A plain box symbol: pins on the left and right on a 2.54 mm grid, tips outward.
  function boxSymbol(pins) {
    const n = pins.length, left = pins.slice(0, Math.ceil(n / 2)), right = pins.slice(Math.ceil(n / 2)).reverse();
    const rows = Math.max(left.length, right.length, 1), h = rows * G, w = 4 * G;
    const y0 = -Math.floor((rows - 1) / 2) * G;
    const out = {pins: [], shapes: [{kind: "path", style: "body", closed: true, fill: true, points: [[-w / 2, y0 - G / 2], [w / 2, y0 - G / 2], [w / 2, y0 - G / 2 + h], [-w / 2, y0 - G / 2 + h]].map(p => p.map(r4))}]};
    const add = (pin, y, side) => {
      const tip = side === "left" ? -w / 2 - G : w / 2 + G;
      out.pins.push({number: String(pin.number), name: pin.name || String(pin.number), x: r4(tip), y: r4(y), electrical: ELECTRICAL_OF[pin.type] ?? 4});
      out.shapes.push({kind: "path", style: "pin", points: [[r4(tip), r4(y)], [r4(side === "left" ? -w / 2 : w / 2), r4(y)]]});
    };
    left.forEach((p, k) => add(p, y0 + k * G, "left"));
    right.forEach((p, k) => add(p, y0 + k * G, "right"));
    return out;
  }
  const prefixOf = ref => (/^[A-Za-z_]+/.exec(ref) || ["U"])[0].toUpperCase();
  // The library definition a netlist component becomes: a project part (or a starter part) whose footprint and
  // pins match; else a generic box symbol that names the footprint, linked to a footprint of that name if the
  // library has one. Waffle never invents manufacturer or supplier part numbers.
  function defFor(p, c, cache, extra) {
    const want = fpKey(c.footprint), pins = new Set(c.pins.map(x => String(x.number)));
    const covers = d => [...pins].every(n => (d.symbol?.pins || []).some(x => String(x.number) === n) &&
      (!d.footprint || (d.footprint.pads || []).some(x => String(x.number) === n)));
    const named = d => want && (fpKey(d.footprint?.name) === want || fpKey(d.footprintName) === want);
    const pool = [...p.library, ...extra.filter(d => !p.library.some(x => x.id === d.id))];
    const full = pool.filter(d => d.symbol && !(d.symbol.parts > 1) && named(d) && covers(d));
    if (full.length) {
      const best = full.find(d => up(d.value) === up(c.value) || up(d.name) === up(c.part)) || full[0];
      if (!p.library.some(d => d.id === best.id)) p.library.push(A.clone(best));
      return {def: p.library.find(d => d.id === best.id), how: "library"};
    }
    // A starter part by package and prefix (KiCad names such as R_0603_1608Metric or LED_0805).
    const pkg = /(0201|0402|0603|0805|1206|1210|SOD-?123|SOT-?23(?:-[356])?|SOT-?223|SMA|SOIC-?8|QFN-?32|LQFP-?48)/i.exec(c.footprint || "")?.[1];
    if (pkg) {
      const norm = s => up(s).replace(/-/g, "");
      const hit = extra.find(d => d.symbol && !(d.symbol.parts > 1) && up(d.prefix) === prefixOf(c.ref) && norm(d.name + " " + d.footprint?.name).includes(norm(pkg)) && covers(d) &&
        (prefixOf(c.ref) !== "D" || /LED/i.test(c.footprint + c.value + c.part) === /LED/i.test(d.name)));
      if (hit) {
        if (!p.library.some(d => d.id === hit.id)) p.library.push(A.clone(hit));
        return {def: p.library.find(d => d.id === hit.id), how: "starter"};
      }
    }
    const footprintDef = want ? pool.find(d => d.footprint && fpKey(d.footprint.name) === want) : null;
    const name = footprintDef ? footprintDef.footprint.name : String(c.footprint || "").replace(/^.*:/, "");
    const key = up(name) + "\u0000" + [...pins].sort(cmp).join(",");
    if (cache.has(key)) return {def: cache.get(key), how: "generic"};
    const def = {id: A.id(), name: "Netlist part " + (name || prefixOf(c.ref)) + " (" + pins.size + " pins)", category: "Netlist import", prefix: prefixOf(c.ref),
      value: c.value || "", symbol: boxSymbol(c.pins.length ? c.pins : [{number: "1"}]), source: "netlist-import"};
    if (name) def.footprintName = name;
    if (footprintDef && !p.library.some(d => d.id === footprintDef.id)) p.library.push(A.clone(footprintDef));
    p.library.push(def);
    cache.set(key, def);
    return {def, how: "generic", added: def.id};
  }
  function importInto(p, parsed, o = {}) {
    if (!parsed || !Array.isArray(parsed.components)) fail("Parse the netlist first.");
    const issues = [...(parsed.issues || [])], extra = Array.isArray(o.starter) ? o.starter : [];
    const used = new Map();
    for (const d of p.documents) if (d.kind === "schematic") for (const i of d.items) if (i.kind === "part" && annotated(i.ref)) used.set(up(i.ref), d.name);
    let board = p.documents.find(d => d.kind === "pcb" && (o.board == null || d.id === o.board || up(d.name) === up(o.board)));
    if (!board && o.board != null) fail("No board is called " + o.board + ".");
    let boardAdded = false;
    if (!board) { board = A.sheet("pcb", "Board layout"); p.documents.push(board); boardAdded = true; }
    let name = String(o.sheet_name || o.sheetName || "Netlist import").trim() || "Netlist import";
    const names = new Set(p.documents.map(d => up(d.name)));
    for (let k = 2; names.has(up(name)); k++) name = (o.sheet_name || o.sheetName || "Netlist import") + " " + k;
    const sheet = A.sheet("schematic", name);
    sheet.grid = 1.27;
    const cache = new Map(), placed = new Map(), defsAdded = [], how = {library: 0, starter: 0, generic: 0};
    let x = 0, y = 0, rowH = 0;
    const WIDTH = 280;
    for (const c of parsed.components) {
      if (used.has(up(c.ref))) { issues.push(c.ref + " is already on sheet " + used.get(up(c.ref)) + "; it is not imported again."); continue; }
      const r = defFor(p, c, cache, extra);
      how[r.how]++;
      o.onDefinition?.(c,r.how);
      if (r.added) defsAdded.push(r.added);
      const b = A.bounds(A.symbolPoints(r.def.symbol)) || [-5, -5, 5, 5], w = b[2] - b[0] + 6 * G, h = b[3] - b[1] + 4 * G;
      if (x > 0 && x + w > WIDTH) { x = 0; y += rowH; rowH = 0; }
      const at = [A.snap(x - b[0] + 3 * G, G), A.snap(y - b[1] + 2 * G, G)];
      const item = A.instantiate(p, r.def, at, 0);
      item.ref = c.ref; item.value = c.value || r.def.value || "";
      const params = Object.fromEntries(Object.entries(c.parameters || {}).filter(([k, v]) => k && v != null).map(([k, v]) => [String(k).slice(0, 128), String(v).slice(0, 512)]));
      if (Object.keys(params).length) item.parameters = params;
      delete item.pinNets;
      sheet.items.push(item);
      placed.set(up(c.ref), {item, def: r.def});
      x += w; rowH = Math.max(rowH, h);
    }
    let labels = 0, nets = 0;
    for (const net of parsed.nets) {
      const nodes = net.nodes.filter(n => placed.has(up(n.ref)));
      // A single-pin net needs no label: the pin is simply unconnected.
      if (nodes.length < 2) continue;
      nets++;
      for (const n of nodes) {
        const {item, def} = placed.get(up(n.ref)), pin = A.pins(item, def, "schematic").find(x => String(x.number) === String(n.pin));
        if (!pin) { issues.push(n.ref + " has no pin " + n.pin + " (net " + net.name + ")."); continue; }
        const lbl = {id: A.id(), kind: "netlabel", x: r4(pin.at[0]), y: r4(pin.at[1]), text: net.name};
        sheet.items.push(lbl); labels++;
      }
    }
    p.documents.push(sheet);
    return {sheet_id: sheet.id, sheet_name: sheet.name, board_id: board.id, board_added: boardAdded, components: placed.size, nets, labels,
      defs_added: defsAdded.length, matched: how, issues};
  }

  // ---------------------------------------------------------------- editor (File menu)
  let host = null;
  async function client() {
    return globalThis.AtriumTranslatorClient || await AtriumLazy.need("AtriumTranslatorClient");
  }
  async function exportAction(format) {
    if (!host) return;
    try {
      const p = host.project(), d = host.doc?.(), revision = host.revision?.();
      const r = await (await client()).export("netlist-" + format,p,{source:d?.kind === "pcb" ? "pcb" : "schematic",
        documentId:d?.id,date:new Date().toISOString(),provenance:globalThis.AtriumImportReports?.provenance()});
      if (host.project() !== p || revision !== host.revision?.()) throw Error("The project changed. Export the netlist again.");
      const {components,nets} = r.details.counts;
      if (!components) { host.info("There are no annotated components to list. Annotate the schematics first."); return; }
      const file = r.files[0];
      if (await host.exportFile(file.name,file.text) === false) return;
      const issues = r.details.diagnostics;
      host.info("Exported " + components + " components and " + nets + " nets from the " + (r.details.source === "pcb" ? "board" : "schematics") + " to " + file.name +
        (issues.length ? " · " + issues.length + " note" + (issues.length === 1 ? "" : "s") + ": " + issues[0] : "") + ".");
      return r;
    } catch (e) { host.info(e.message); }
  }
  async function importFiles(files, options = {}) {
    if (!host) throw Error("Open a project to import a netlist.");
    const p = host.project(), revision = host.revision?.(), d = host.doc?.();
    if (!globalThis.AtriumStarterLibrary && globalThis.AtriumLazy) {
      try { await AtriumLazy.need("AtriumStarterLibrary"); } catch { /* Generic symbols remain available. */ }
    }
    const c = await client(), starter = globalThis.AtriumStarterLibrary?.defs() || [];
    const r = await c.import(files,{...options,project:p,documentId:d?.kind === "pcb" ? d.id : undefined,starter,
      provenance:globalThis.AtriumImportReports?.provenance()});
    if (host.project() !== p || revision !== host.revision?.()) throw Error("The project changed. Import the netlist again.");
    const summary = r.provenance.netlist;
    if (!summary) throw Error("Select a KiCad, Protel or CSV netlist.");
    const entry = r.provenance.files[0], docs = new Set(entry.documents), lib = new Set(entry.library);
    host.edit(() => {
      p.library.push(...r.model.library.filter(def => lib.has(def.id)));
      p.documents.push(...r.model.documents.filter(doc => docs.has(doc.id)));
    });
    host.info("Imported " + summary.components + " components and " + summary.nets + " nets into sheet " + summary.sheet_name +
      (summary.issues.length ? " · " + summary.issues[0] : "") + ". Review the change order to add them to the board.");
    host.selectDocument?.(summary.board_id);
    await host.showImportReport?.(r,entry.documents,files.map(f => f.name));
    if (host.project() === p) setTimeout(() => { if (host.project() === p) host.act?.("eco"); },0);
    return r;
  }
  async function importAction() {
    if (!host) return;
    try {
      const owner = host.project(), revision = host.revision?.();
      const f = await AtriumIO.pickFile([".net",".NET",".csv",".txt",".frp"]);
      if (!f) return;
      const bytes = typeof f.bytes === "function" ? await f.bytes() : f.bytes || new Uint8Array(await f.arrayBuffer());
      if (host.project() !== owner || revision !== host.revision?.()) throw Error("The project changed. Import the netlist again.");
      return await importFiles([{name:f.name,bytes}]);
    } catch (e) { host.info(e.message); }
  }
  function attach(h) {
    host = h;
    h.registerAction("import-netlist", importAction);
    h.registerAction("export-netlist-kicad", () => exportAction("kicad"));
    h.registerAction("export-netlist-protel", () => exportAction("protel"));
    h.registerAction("export-netlist-csv", () => exportAction("csv"));
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({pinTypes:Object.freeze(TYPES), extract, kicad, protel, csv, parse, detect, importInto, importFiles, boxSymbol, attach, sexpr});
})();
