"use strict";
if (!globalThis.AtriumLibraryPairing && typeof require === "function") require("./library-pairing.js");
// Symbol Wizard: a schematic symbol from a datasheet pin table, in one dialog.
//
// Paste a pin table (tab, comma or semicolon separated, PDF text with column gaps, or plain
// space-separated PDF text such as "1 VDD power" or "PA0 / ADC_IN0 12 I/O"), or import one
// from a CSV file, a KiCad .kicad_sym library or an Altium SchLib. The wizard finds the
// columns (number, name, electrical type, alternate functions), types pins from their names
// (GND/VSS/VDD/VCC power, NC no-connect, nRESET/RESET#//CS/~{CS} active low with an overbar),
// lays the symbol out (by function, as gates by group, or around the body in package order)
// on the 2.54 mm (100 mil) grid, checks the table inline and opens the result in the Symbol
// Editor with a footprint from the de-duplicated picker. The table is data: it is split and
// matched against fixed patterns, never evaluated.
//
// DOM-free core (also used by the MCP tool create_symbol_from_table through headless()):
//   detect(text, {mode, header})          -> {mode, header, headers, columns, cells, roles}
//   pinsOf(table, {roles, smart, split, activeLow, edits}) -> {pins, notes}
//   check(pins, {footprint})              -> [{level, code, message, keys}]
//   layout(pins, {layout, preset, pitch, length, power}) -> editor model {pins, shapes, parts}
//   build(pins, o)                        -> def {name, prefix, symbol, schDrawing?, footprint?}
//   activeLow(name), styleName(base, style), typeCode(text), channels(pins)
//   tableFromDef(def), kicadSymbols(text) -> [{name, text}]  (existing symbols as pin tables)
//   headless(args, {mutable, touched})    -> MCP result (a library edit on the working copy)
//   open(ctx), workflows["symbol-wizard"]
globalThis.AtriumSymbolWizard = (() => {
  const Lib = () => globalThis.AtriumLibrary;
  const G = 2.54;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const MAX_TEXT = 200000, MAX_ROWS = 4096;
  const ROLES = ["number", "name", "type", "alternates", "description", "side", "gate", "hidden", "ignore"];
  const ROLE_LABEL = {number: "Number", name: "Name", type: "Type", alternates: "Alternates", description: "Description", side: "Side", gate: "Gate", hidden: "Hidden", ignore: "Ignore"};
  const UNIQUE = new Set(["number", "name", "type", "alternates", "side", "gate", "hidden"]);
  const natural = s => String(s ?? "").replace(/\d+/g, d => d.padStart(8, "0")).toLowerCase();
  const byNatural = (a, b) => natural(a).localeCompare(natural(b));

  // ------------------------------------------------------------------ vocabulary
  // Electrical type words from datasheets, spreadsheets and KiCad (0..7 in Altium order, "nc").
  // Datasheet convention: P/S/G are power, supply and ground; "passive" is written out.
  const TYPES = new Map();
  for (const [code, words] of [
    [0, "i,in,input,input only,ai,analog input,analog in,di,digital input,clock input,schmitt input,i (analog),i(analog),ia"],
    [1, "i/o,io,inout,in/out,bidir,bidirectional,b,dio,digital i/o,analog i/o,i/o/z,io/z,a/io,i/o (ft),bi"],
    [2, "o,out,output,ao,analog output,do,digital output,push pull,pp,o (pp)"],
    [3, "oc,open collector,od,open drain,o/od,o (od),odo,open drain output,i/o/od,io/od"],
    [4, "passive,pas,a,analog,analog passive,free,unspecified,r,c,x"],
    [5, "hiz,hi z,tri state,tristate,3 state,z,ts,o/z"],
    [6, "oe,open emitter,open source,os"],
    [7, "p,pwr,power,s,supply,g,gnd,ground,power in,power out,power input,power output,supply input,pi,po,w,p/g,pg/ps,ps,pwr/gnd,ref"],
    ["nc", "nc,-,—,–,n/c,dnc,no connect,not connected,nic,no_connect,no connection,reserved,rsvd"]
  ]) for (const w of words.split(",")) TYPES.set(w, code);
  const typeKey = t => String(t ?? "").trim().toLowerCase().replace(/_/g, " ").replace(/([a-z])-([a-z])/g, "$1 $2").replace(/\s+/g, " ");
  // Code for a type word: 0..7, "nc", null for an empty cell, undefined when unknown.
  function typeCode(text) {
    const k = typeKey(text);
    if (!k) return null;
    if (TYPES.has(k)) return TYPES.get(k);
    if (/^[0-7]$/.test(k)) return +k;
    const lead = k.split(/[\s(,]/)[0];
    return TYPES.has(lead) && lead.length > 1 ? TYPES.get(lead) : undefined;
  }
  const NC_NAME = /^(nc|n\/c|dnc|nic|rsvd|reserved|do not connect)$/i;
  const GROUND = /^([adpcs]?gnd\w*|vss\w*|[ad]?vss|v-|vee|0v|ep|epad|e-?pad|pad|thermal|com|gnd_?pad|exposed pad)$/i;
  const NUMBER = /^(\d+([.,;\s]+\d+)*|\d+\s*[-–]\s*\d+|[A-HJ-NPR-Y]{1,2}(0?[1-9]|[1-9]\d)([,;\s]+[A-HJ-NPR-Y]{1,2}(0?[1-9]|[1-9]\d))*)$/;
  const IDENT = /^[~/!+\-]?[A-Za-z0-9_+\-][\w+\-#.[\]()/~{}\\̅]*$/;
  const ACTIVE_N = /^N(RST|RESET|CS|SS|OE|WE|WR|RD|EN|IRQ|INT|SLEEP|SHDN|PD|FAULT|FLT|PG|ALERT|BUSY|RDY|READY|HOLD|WP|MCLR|PWRDN|STBY|LDAC|CLR|PRE|SET|DRDY|ACK|REQ)$/;

  // Active-low names: nRESET, NRST, RESET#, RESET_N, RSTn, /CS, !CS, ~CS, ~{CS} (KiCad),
  // R\E\S\E\T\ (Altium) and an existing combining overline. -> {base, low}
  function activeLow(raw) {
    const s = String(raw ?? "").trim();
    let m;
    if ((m = /^~\{([^}]+)\}(.*)$/.exec(s))) return {base: m[1] + m[2], low: true};
    if (/^(?:[^\\]\\)+$/.test(s)) return {base: s.replace(/\\/g, ""), low: true};
    if (s.includes("̅")) return {base: s.replace(/̅/g, ""), low: true};
    if (s.length > 1 && /^[/~!]/.test(s)) return {base: s.slice(1), low: true};
    if (s.length > 1 && s.endsWith("#")) return {base: s.slice(0, -1), low: true};
    if (/^n[A-Z][A-Z0-9_]*$/.test(s) && s.length > 2) return {base: s.slice(1), low: true};
    if (ACTIVE_N.test(s)) return {base: s.slice(1), low: true};
    if (/^[A-Za-z]\w*_[Nn]$/.test(s) && s.length > 3) return {base: s.slice(0, -2), low: true};
    if (/^[A-Z][A-Z0-9_]*[A-Z]n$/.test(s)) return {base: s.slice(0, -1), low: true};
    return {base: s, low: false};
  }
  // How an active-low name is written: overbar (combining U+0305 on each character, drawn by the
  // canvas as a bar), "altium" (R\E\S\E\T\, as Altium stores it) or "keep" (as typed).
  function styleName(base, style, typed) {
    if (style === "keep") return typed ?? base;
    const chars = [...String(base)];
    return style === "altium" ? chars.map(c => c + "\\").join("") : chars.map(c => c + "̅").join("");
  }
  const visible = s => String(s ?? "").replace(/[̀-ͯ]/g, "").replace(/\\/g, "");

  // ------------------------------------------------------------------ splitting
  function countOutside(line, ch) { let n = 0, q = false; for (const c of line) { if (c === '"') q = !q; else if (c === ch && !q) n++; } return n; }
  function splitRows(src, delim) {
    const rows = []; let row = [], cell = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
      else if (c === '"' && !cell.trim()) { quoted = true; cell = ""; }
      else if (c === delim) { row.push(cell.trim()); cell = ""; }
      else if (c === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    row.push(cell.trim()); rows.push(row);
    return rows.filter(r => r.some(c => c !== ""));
  }
  const HEAD = [
    ["number", /^(pin\s*(no\.?|number|num|#|nr\.?)?|no\.?|number|num|#|pad|pads|ball|ball\s*(no\.?|#)?|designator|pin\s*designator|terminal|(l|t|u|v|w)?qfp\s*\d*|(u|v|w|x)?qfn\s*\d*|(t|s|m)?ssop\s*\d*|soic?\s*\d*|so-?\d+|dip\s*\d*|bga\s*\d*|(wl)?csp\s*\d*|dfn\s*\d*|son\s*\d*|sot(-?\d+)?|msop\s*\d*|ufqfpn\s*\d*|lqfp\s*\d*|tqfp\s*\d*|qfn-?\d+.*|.*\bpin\s*(no\.?|number|#))$/i],
    ["name", /^(name|signal|signal\s*name|pin\s*name|net|display\s*name|symbol|mnemonic|pin\s*function|terminal\s*name)$/i],
    ["type", /^(type|electrical(\s*type)?|elec\w*|dir(ection)?|i\/o|pin\s*type|i\/o\s*type|kind|i\/o\s*structure|io)$/i],
    ["alternates", /^(alt(ernate)?s?(\s*func\w*)?|alternate\s*functions?|additional\s*functions?|af|remap|functions?|other\s*functions?|mux)$/i],
    ["description", /^(desc\w*|comment|notes?|function\s*description|details?)$/i],
    ["side", /^(side|position|edge|location)$/i],
    ["gate", /^(part|gate|unit)$/i],
    ["hidden", /^(hidden|hide)$/i]
  ];
  const headerRole = c => { const t = String(c ?? "").trim(); for (const [k, re] of HEAD) if (re.test(t)) return k; return null; };
  const isNumber = c => NUMBER.test(String(c ?? "").trim());
  const isType = c => { const v = typeCode(c); return v !== undefined && v !== null; };
  const isIdent = c => IDENT.test(String(c ?? "").trim()) && !/^\d+$/.test(String(c).trim());

  // Plain PDF text, one pin per line: number, name (with " / " alternates), type, the rest.
  const TWO_WORD = /^(open (drain|collector|emitter|source)|power (in|out|input|output)|no connect|not connected|tri state|3 state|push pull|analog (input|output|in|i\/o))$/i;
  function classify(line) {
    let t = line.trim().split(/\s+/);
    // "PA0 / ADC_IN0" and "PA0, ADC_IN0": one cell. "5, 10": one number cell.
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "/" && i > 0 && i + 1 < t.length) { t.splice(i - 1, 3, t[i - 1] + "/" + t[i + 1]); i -= 2; continue; }
      if (/[/,]$/.test(t[i]) && t[i].length > 1 && i + 1 < t.length) { t.splice(i, 2, t[i] + t[i + 1]); i--; }
    }
    for (let i = 0; i + 1 < t.length; i++) if (TWO_WORD.test(t[i] + " " + t[i + 1])) { t.splice(i, 2, t[i] + " " + t[i + 1]); }
    const used = new Set();
    let number = "", type = "";
    const ni = t.findIndex(x => /^\d+([,;]\d+)*$/.test(x) || /^\d+[-–]\d+$/.test(x));
    const bi = ni < 0 ? t.findIndex((x, i) => i < 2 && /^[A-HJ-NPR-Y]{1,2}(0?[1-9]|[1-9]\d)$/.test(x) && t.length > 2) : -1;
    const at = ni >= 0 ? ni : bi;
    if (at >= 0) { number = t[at]; used.add(at); }
    // The type is the last type word that still leaves a name before it.
    for (let i = t.length - 1; i >= 0; i--) {
      if (used.has(i) || !isType(t[i])) continue;
      const before = t.some((x, k) => k < i && !used.has(k));
      if (before) { type = t[i]; used.add(i); break; }
    }
    const typeAt = type ? t.indexOf(type) : t.length;
    const rest = t.map((x, i) => [x, i]).filter(([, i]) => !used.has(i));
    const name = rest.length ? rest[0][0] : "";
    const alts = [], desc = [];
    for (const [x, i] of rest.slice(1)) {
      const signal = !desc.length && (/[_\d/,]/.test(x) || /^[A-Z][A-Z0-9+\-#]*$/.test(x)) && !/^[a-z]/.test(x);
      if ((type && i < typeAt) || signal) alts.push(x); else desc.push(x);
    }
    return [number, name, type, alts.join(", "), desc.join(" ")];
  }

  // ------------------------------------------------------------------ detection
  // Mode: "tab", "csv", "semicolon", "columns" (two or more spaces between columns), "space".
  function detect(text, o = {}) {
    const src = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (src.length > MAX_TEXT) throw Error("The pin table is too long (over " + MAX_TEXT.toLocaleString("en") + " characters).");
    const lines = src.split("\n").filter(l => l.trim());
    let mode = o.mode && o.mode !== "auto" ? o.mode : null;
    if (!mode) {
      const sample = lines.slice(0, 60);
      const consistent = ch => {
        const counts = sample.map(l => countOutside(l, ch)), freq = new Map();
        for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
        const [modal, n] = [...freq].sort((a, b) => b[1] - a[1])[0] || [0, 0];
        return modal > 0 && n >= .8 * counts.length;
      };
      mode = sample.some(l => l.includes("\t")) ? "tab" : consistent(",") ? "csv" : consistent(";") ? "semicolon"
        : sample.length > 1 && sample.filter(l => /\S {2,}\S/.test(l.trim())).length >= .6 * sample.length ? "columns" : "space";
    }
    let cells;
    if (mode === "space") cells = lines.map(classify);
    else if (mode === "columns") cells = lines.map(l => l.trim().split(/\s{2,}|\t/).map(c => c.trim()));
    else cells = splitRows(src, {tab: "\t", csv: ",", semicolon: ";"}[mode] || "\t");
    if (cells.length > MAX_ROWS + 1) throw Error("The pin table has too many rows (over " + MAX_ROWS + ").");
    const columns = Math.max(0, ...cells.map(r => r.length));
    for (const r of cells) while (r.length < columns) r.push("");
    let header = false, headers = null, roles;
    if (mode === "space") {
      roles = ["number", "name", "type", "alternates", "description"];
      const first = lines[0]?.trim().split(/\s+/) || [];
      header = o.header ?? (first.length > 1 && first.filter(w => headerRole(w)).length >= 2 && !first.some(w => /^\d+$/.test(w)));
      if (header) { headers = lines[0].trim().split(/\s+/); cells.shift(); }
    } else {
      const first = cells[0] || [];
      const hits = first.map(headerRole);
      header = o.header ?? (hits.filter(Boolean).length >= 1 && first.filter(isNumber).length <= (hits.includes("number") ? 0 : 1) && cells.length > 1);
      if (header) { headers = first.slice(); cells.shift(); }
      roles = guessRoles(cells, columns, header ? hits : []);
    }
    return {mode, header, headers, columns: mode === "space" ? 5 : columns, cells, roles};
  }
  function guessRoles(cells, columns, hits) {
    const roles = Array(columns).fill(null), sample = cells.slice(0, 200);
    // Header words first; a second "function" column after a name column is alternates.
    hits.forEach((k, i) => { if (!k) return; if (UNIQUE.has(k) && roles.includes(k)) { if (k === "name" && !roles.includes("alternates")) roles[i] = "alternates"; return; } roles[i] = k; });
    const score = (i, test) => { const v = sample.map(r => r[i]).filter(c => c !== "" && c != null); return v.length ? v.filter(test).length / v.length : 0; };
    const free = () => roles.map((r, i) => r ? -1 : i).filter(i => i >= 0);
    const pick = (role, test, min) => {
      if (roles.includes(role)) return;
      let best = -1, bs = min;
      for (const i of free()) { const s = score(i, test); if (s > bs + 1e-9) { bs = s; best = i; } }
      if (best >= 0) roles[best] = role;
    };
    pick("number", isNumber, .69);
    pick("type", isType, .59);
    if (!roles.includes("name")) { const i = free().find(k => score(k, isIdent) >= .5); if (i != null) roles[i] = "name"; }
    const signals = c => String(c).split(/\s*[/,;]\s*/).every(x => /^[A-Za-z0-9_+\-#~]+$/.test(x));
    pick("alternates", c => signals(c) && (/[/,;]/.test(c) || /^[A-Z][A-Z0-9_]+$/.test(c)), .29);
    // "Function" columns that hold sentences are descriptions, not alternate functions.
    const prose = c => /[a-z]{3,}\s+[a-z]{2,}/i.test(c) && !signals(c);
    roles.forEach((r, i) => { if (r === "alternates" && score(i, prose) >= .5) roles[i] = "description"; });
    for (const i of free()) roles[i] = sample.some(r => /\s\S+\s/.test(r[i] || "")) ? "description" : "ignore";
    return roles;
  }

  // ------------------------------------------------------------------ pins
  function numbersOf(cell) {
    const s = String(cell ?? "").trim();
    let m;
    if ((m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(s)) && +m[2] > +m[1] && +m[2] - +m[1] <= 64) return Array.from({length: +m[2] - +m[1] + 1}, (_, k) => String(+m[1] + k));
    return s.split(/\s*[,;]\s*|\s+/).filter(Boolean);
  }
  const SIDES = {l: "left", left: "left", w: "left", west: "left", r: "right", right: "right", e: "right", east: "right", t: "top", top: "top", n: "top", north: "top", up: "top",
    b: "bottom", bottom: "bottom", s: "bottom", south: "bottom", down: "bottom"};
  function splitName(name) {
    const lead = name.startsWith("/") ? "/" : "", body = lead ? name.slice(1) : name;
    const parts = body.split(/\s*\/\s*/);
    return parts.length > 1 && parts.every(x => x.length >= 2) ? [lead + parts[0], parts.slice(1)] : [name, []];
  }
  // Table + roles -> pins. edits: {key: {number, name, low, type, alternates, side, part, include}}.
  function pinsOf(table, o = {}) {
    const roles = o.roles && o.roles.length === table.columns ? o.roles : table.roles;
    const col = k => roles.indexOf(k), L = Lib(), notes = [];
    const smart = o.smart !== false, edits = o.edits || {};
    const out = [];
    let auto = 1;
    table.cells.forEach((r, ri) => {
      const get = k => col(k) >= 0 ? String(r[col(k)] ?? "").trim() : "";
      let name = get("name"), alternates = get("alternates") ? get("alternates").split(/\s*[/,;]\s*|\s{2,}/).filter(Boolean) : [];
      if (o.split !== false && name.includes("/")) { const [n, a] = splitName(name); name = n; alternates = [...a, ...alternates]; }
      const numbers = col("number") >= 0 ? numbersOf(get("number")) : [String(auto)];
      if (!numbers.length && !name) return;
      if (!numbers.length) numbers.push(String(auto));
      const typeText = get("type"), sideText = get("side").toLowerCase(), gateText = get("gate");
      const part = /^[A-Z]$/i.test(gateText) ? gateText.toUpperCase().charCodeAt(0) - 64 : /^\d+$/.test(gateText) ? +gateText : undefined;
      numbers.forEach((number, k) => {
        const key = ri + ":" + k, e = edits[key] || {};
        const typed = e.name ?? name, al = activeLow(typed), low = e.low ?? al.low, base = low ? al.base : typed.trim();
        const tt = e.type ?? typeText;
        let code = e.type != null && e.type !== "" ? (e.type === "nc" ? "nc" : +e.type) : typeCode(tt);
        if (e.type == null || e.type === "") {
          if (code === undefined) notes.push({level: "info", code: "type", message: "Pin " + number + ": type “" + tt + "” is not one Waffle knows; it was inferred from the name.", keys: [key]});
          const given = code;
          if (smart && NC_NAME.test(base)) code = "nc";
          else if (smart && L.inferElectrical(base) === 7) code = 7;
          else if (code == null) code = L.inferElectrical(base);
          if (given != null && given !== code && !/^[-—–]$/.test(tt.trim())) notes.push({level: "info", code: "smart", message: "Pin " + number + " " + base + ": the table says " + tt + "; smart typing made it " + (code === "nc" ? "no-connect" : L.ELECTRICAL[code]) + ".", keys: [key]});
        }
        const nc = code === "nc";
        const pin = {key, row: ri, number: String(e.number ?? number).trim(), typed, base, low, name: low ? styleName(base, o.activeLow || "overbar", typed) : base,
          electrical: nc ? 4 : code, nc, alternates: e.alternates != null ? String(e.alternates).split(/\s*[/,;]\s*/).filter(Boolean) : alternates,
          description: get("description"), include: e.include !== false};
        const side = e.side ?? SIDES[sideText];
        if (side && side !== "auto") pin.side = side;
        const pt = e.part ?? part;
        if (Number.isInteger(pt) && pt >= 0) pin.part = pt;
        if (/^(y|yes|true|1|x|hide|hidden)$/i.test(get("hidden"))) pin.hidden = true;
        out.push(pin);
      });
      auto = (parseInt(numbers.at(-1), 10) || auto) + 1;
    });
    return {pins: out, notes};
  }

  // ------------------------------------------------------------------ checks
  function ranges(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) { let j = i; while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++; out.push(j > i ? list[i] + "–" + list[j] : String(list[i])); i = j; }
    return out;
  }
  function check(all, o = {}) {
    const pins = all.filter(p => p.include !== false), out = [];
    if (!pins.length) { out.push({level: "error", code: "empty", message: "No pins: paste a pin table or import one.", keys: []}); return out; }
    const byNumber = new Map();
    for (const p of pins) { if (!p.number) { out.push({level: "error", code: "number", message: "Row " + (p.row + 1) + " (" + (p.base || "unnamed") + ") has no pin number.", keys: [p.key]}); continue; } const k = p.number.toUpperCase(); if (!byNumber.has(k)) byNumber.set(k, []); byNumber.get(k).push(p); }
    for (const [n, list] of byNumber) if (list.length > 1) out.push({level: "error", code: "duplicate", message: "Pin " + list[0].number + " appears " + list.length + " times (" + list.map(p => p.base || "unnamed").join(", ") + ").", keys: list.map(p => p.key)});
    // Gaps in a numeric range, and in each row of BGA ball ids.
    const ints = [...byNumber.keys()].filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
    if (ints.length > 1 && ints.length >= .6 * byNumber.size) {
      const have = new Set(ints), miss = [];
      for (let n = Math.min(1, ints[0]); n <= ints.at(-1); n++) if (!have.has(n)) miss.push(n);
      if (miss.length) out.push({level: "warning", code: "missing", message: "Missing pin number" + (miss.length > 1 ? "s " : " ") + ranges(miss).slice(0, 12).join(", ") + (ranges(miss).length > 12 ? "…" : "") + " between 1 and " + ints.at(-1) + ".", keys: []});
    }
    const balls = new Map();
    for (const n of byNumber.keys()) { const m = /^([A-Z]{1,2})(\d+)$/.exec(n); if (m) { if (!balls.has(m[1])) balls.set(m[1], []); balls.get(m[1]).push(+m[2]); } }
    if (balls.size > 1) {
      const gaps = [];
      for (const [r, list] of balls) { list.sort((a, b) => a - b); for (let c = list[0]; c <= list.at(-1); c++) if (!list.includes(c)) gaps.push(r + c); }
      if (gaps.length) out.push({level: "info", code: "missing-balls", message: "Ball rows have gaps: " + gaps.slice(0, 16).join(", ") + (gaps.length > 16 ? " …" : "") + " (fine for a depopulated array).", keys: []});
    }
    // One name, several types.
    const byName = new Map();
    for (const p of pins) { if (p.nc || !p.base) continue; const k = p.base.toUpperCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
    const E = Lib().ELECTRICAL;
    for (const list of byName.values()) {
      const types = [...new Set(list.map(p => p.electrical))];
      if (types.length > 1) out.push({level: "warning", code: "mixed-type", message: list[0].base + " has different types: " + types.map(t => E[t] + " (" + list.filter(p => p.electrical === t).map(p => p.number).join(", ") + ")").join(", ") + ".", keys: list.map(p => p.key)});
    }
    const unnamed = pins.filter(p => !p.base && !p.nc);
    if (unnamed.length) out.push({level: "info", code: "unnamed", message: unnamed.length + " pin" + (unnamed.length > 1 ? "s have" : " has") + " no name: " + unnamed.slice(0, 8).map(p => p.number).join(", ") + ".", keys: unnamed.map(p => p.key)});
    const fp = o.footprint;
    if (fp?.pads) {
      const pads = new Set(fp.pads.filter(p => !p.thermalVia).map(p => String(p.number).toUpperCase())), nums = new Set(byNumber.keys());
      const {noPad, noPin} = globalThis.AtriumLibraryPairing.difference(nums, pads);
      if (noPad.length) out.push({level: "warning", code: "no-pad", message: "Pins without a pad in " + (fp.name || "the footprint") + ": " + noPad.slice(0, 12).join(", ") + (noPad.length > 12 ? " …" : "."), keys: pins.filter(p => noPad.includes(p.number.toUpperCase())).map(p => p.key)});
      if (noPin.length) out.push({level: "warning", code: "no-pin", message: "Pads without a pin: " + noPin.slice(0, 12).join(", ") + (noPin.length > 12 ? " …" : "."), keys: []});
    }
    return out;
  }

  // ------------------------------------------------------------------ grouping
  function kind(p) {
    if (p.nc) return "nc";
    const e = p.electrical ?? 4;
    if (e === 7) return GROUND.test(p.base) ? "ground" : "power";
    return ["input", "io", "output", "output", "passive", "output", "output", "power"][e];
  }
  // Port or bus a pin belongs to: PA0 -> PA, P1.2 / P1_2 -> P1, GPIO12 -> GPIO, D3 -> D.
  function portKey(base) {
    const s = String(base || "").toUpperCase();
    let m;
    if ((m = /^P([A-Z])\d{1,2}$/.exec(s))) return "P" + m[1];
    if ((m = /^(P|GPIO|IO)(\d+)[._](\d+)$/.exec(s))) return m[1] + m[2];
    if ((m = /^(.*?[A-Z_])\d+$/.exec(s)) && m[1].length <= 8) return m[1].replace(/_$/, "");
    return null;
  }
  // Channels of a multi-channel part (op amps, comparators, drivers): OUTA/-INA/+INA,
  // 1OUT/1IN-/1IN+, IN1+/IN1-/OUT1. -> Map(pin key -> channel) or null.
  const SCHEMES = [
    s => /^(\d)([A-Z+\-].*)$/i.exec(s)?.slice(1, 3),
    s => { const m = /^(.*?[^\d\s])([A-D])([+-]?)$/.exec(s); return m && [m[2], m[1] + m[3]]; },
    s => { const m = /^(.*?\D)([1-8])([+-])$/.exec(s); return m && [m[2], m[1] + m[3]]; },
    s => { const m = /^(OUT|IN|FB|EN|SHDN|SD|SW|LX|BST|BOOT|SS|COMP|PG|SENSE|ISNS)_?([1-8])$/i.exec(s); return m && [m[2], m[1].toUpperCase()]; }
  ];
  function channels(pins) {
    const cand = pins.filter(p => p.include !== false && !p.nc && kind(p) !== "power" && kind(p) !== "ground");
    for (const scheme of SCHEMES) {
      const hit = new Map(), stems = new Map();
      for (const p of cand) {
        const r = scheme(p.base.toUpperCase());
        if (!r || /^P[A-Z]$/.test(r[1])) continue;
        hit.set(p.key, r[0]);
        if (!stems.has(r[0])) stems.set(r[0], new Set());
        stems.get(r[0]).add(r[1]);
      }
      const sets = [...stems.values()];
      if (sets.length < 2 || sets.length > 8 || hit.size < 4 || sets.some(s => s.size < 2)) continue;
      const key = s => [...s].sort().join("|");
      if (sets.every(s => key(s) === key(sets[0]))) return hit;
    }
    return null;
  }

  // ------------------------------------------------------------------ layout
  const textWidth = s => visible(s).length * 2.032 * .6;
  // Sides by function: power on top, ground at the bottom, inputs left, outputs right, ports and
  // buses kept together (PA* in one block, PB* in the next) and balanced, no-connects last.
  function sidesByFunction(pins) {
    const s = {left: [], right: [], top: [], bottom: []}, fixed = {left: [], right: [], top: [], bottom: []};
    const power = [], ground = [], inputs = [], outputs = [], nc = [], loose = [], ports = new Map();
    const counts = new Map();
    for (const p of pins) { const k = portKey(p.base); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    for (const p of pins) {
      if (p.side) { fixed[p.side].push(p); continue; }
      const k = kind(p), pk = portKey(p.base);
      if (k === "power") power.push(p); else if (k === "ground") ground.push(p); else if (k === "nc") nc.push(p);
      else if (pk && counts.get(pk) > 1 && (k === "io" || k === "passive" || /^P/.test(pk))) { if (!ports.has(pk)) ports.set(pk, []); ports.get(pk).push(p); }
      else if (k === "input") inputs.push(p); else if (k === "output") outputs.push(p); else loose.push(p);
    }
    const byName = (a, b) => byNatural(a.base, b.base) || byNatural(a.number, b.number);
    power.sort(byName); ground.sort(byName);
    const size = side => s[side].reduce((n, g) => n + g.length + 1, 0);
    // Inputs and outputs keep table order, with buses (A0..A7) gathered and sorted.
    const gather = list => { const out = [], seen = new Map(); for (const p of list) { const k = portKey(p.base); if (k && counts.get(k) > 1) { if (!seen.has(k)) { seen.set(k, []); out.push(seen.get(k)); } seen.get(k).push(p); } else out.push([p]); } return out.map(g => g.sort(byName)); };
    const inGroups = gather(inputs), outGroups = gather(outputs);
    if (inGroups.length) s.left.push(inGroups.flat());
    if (outGroups.length) s.right.push(outGroups.flat());
    for (const k of [...ports.keys()].sort(byNatural)) (size("left") <= size("right") ? s.left : s.right).push(ports.get(k).sort(byName));
    if (loose.length) (size("left") <= size("right") ? s.left : s.right).push(loose);
    if (nc.length) s.right.push(nc.sort(byName));
    // Many power pins: the top edge holds up to 16, the rest join the sides.
    if (power.length) s.top.push(power.slice(0, 16));
    if (power.length > 16) s.left.unshift(power.slice(16));
    if (ground.length) s.bottom.push(ground.slice(0, 16));
    if (ground.length > 16) s.right.push(ground.slice(16));
    for (const side of Object.keys(fixed)) if (fixed[side].length) s[side].push(fixed[side]);
    return s;
  }
  // Sides in package order: dual (DIP/SOIC: down the left, up the right), quad (QFP/QFN:
  // counter-clockwise from pin 1 at the top left) or single (one column, like a header).
  function sidesByPackage(pins, preset = "dual") {
    const s = {left: [], right: [], top: [], bottom: []}, fixed = {left: [], right: [], top: [], bottom: []};
    const list = pins.filter(p => { if (p.side) { fixed[p.side].push(p); return false; } return true; }).sort((a, b) => byNatural(a.number, b.number));
    const n = list.length;
    if (preset === "quad") {
      const q = Math.ceil(n / 4);
      s.left.push(list.slice(0, q)); s.bottom.push(list.slice(q, 2 * q)); s.right.push(list.slice(2 * q, 3 * q).reverse()); s.top.push(list.slice(3 * q).reverse());
    } else if (preset === "single") s.left.push(list);
    else if (preset === "single-right") s.right.push(list);
    else { const h = Math.ceil(n / 2); s.left.push(list.slice(0, h)); s.right.push(list.slice(h).reverse()); }
    for (const side of Object.keys(fixed)) if (fixed[side].length) s[side].push(fixed[side]);
    for (const side of Object.keys(s)) s[side] = s[side].filter(g => g.length);
    return s;
  }
  // Geometry for one body: every pin tip on the grid, names inside, top/bottom names vertical.
  function place(sides, o = {}) {
    const g = o.pitch || G, len = o.length || 2 * G, part = o.part;
    const slots = (groups, gaps) => { const out = []; groups.forEach((grp, i) => { if (i && gaps) out.push(null); out.push(...grp); }); return out; };
    const Lp = slots(sides.left, true), Rp = slots(sides.right, true), Tp = slots(sides.top, false), Bp = slots(sides.bottom, false);
    const w = list => Math.max(0, ...list.filter(Boolean).map(p => textWidth(p.name)));
    const lw = w(Lp), rw = w(Rp), tw = w(Tp), bw = w(Bp);
    const rows = Math.max(Lp.length, Rp.length, 1);
    let width = Math.max(4 * G, lw + rw + 2 * G, (Math.max(Tp.length, Bp.length) + 1) * g, o.minWidth || 0);
    width = Math.ceil(width / (2 * G) - 1e-9) * 2 * G;
    const band = (list, tw) => list.length ? Math.ceil((tw + .8) / G - 1e-9) * G : 0;
    const topBand = band(Tp, tw), bottomBand = band(Bp, bw);
    const height = Math.max((rows + 1) * g + topBand + bottomBand, o.minHeight || 0);
    const x0 = -width / 2, x1 = width / 2, y0 = -Math.round(height / 2 / G) * G, y1 = y0 + Math.ceil(height / G - 1e-9) * G;
    const pins = [];
    const add = (p, x, y, orientation) => pins.push({number: p.number, name: p.name, x: r6(x), y: r6(y), electrical: p.electrical ?? 4, orientation, length: len,
      ...(p.hidden ? {hidden: true} : {}), ...(p.nc ? {noConnect: true} : {}), ...(p.alternates?.length ? {alternates: p.alternates.slice()} : {}),
      ...(part != null ? {part: p.shared ? 0 : part} : {}), key: p.key});
    const start = n => y0 + topBand + g + Math.floor((rows - n) / 2) * g;
    Lp.forEach((p, i) => p && add(p, x0 - len, start(Lp.length) + i * g, "left"));
    Rp.forEach((p, i) => p && add(p, x1 + len, start(Rp.length) + i * g, "right"));
    const across = n => -Math.floor((n - 1) / 2) * g;
    Tp.forEach((p, i) => p && add(p, across(Tp.length) + i * g, y0 - len, "up"));
    Bp.forEach((p, i) => p && add(p, across(Bp.length) + i * g, y1 + len, "down"));
    const shapes = [{kind: "path", style: "body", closed: true, fill: true, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => p.map(r6)), ...(part != null ? {part} : {})}];
    return {pins, shapes, width, height: y1 - y0};
  }
  // Gates by group: one per channel (op amps), port (PA, PB, …) or explicit gate column, the
  // remaining signals in a control gate and the supplies in a power gate (or on every gate).
  function gatesOf(pins, o = {}) {
    const ch = channels(pins), counts = new Map(), groups = new Map();
    for (const p of pins) { const k = portKey(p.base); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    const put = (k, label, p) => { if (!groups.has(k)) groups.set(k, {key: k, label, pins: []}); groups.get(k).pins.push(p); };
    const explicit = pins.some(p => p.part > 0);
    for (const p of pins) {
      const k = kind(p);
      if (explicit) { put("g" + String(p.part || 0).padStart(3, "0"), p.part ? "Gate " + p.part : "Shared", p); continue; }
      if (k === "power" || k === "ground") put("~power", "Power", p);
      else if (ch?.has(p.key)) put("ch" + ch.get(p.key), "Channel " + ch.get(p.key), p);
      else if (portKey(p.base) && counts.get(portKey(p.base)) > 2 && k !== "nc") put("p" + portKey(p.base), "Port " + portKey(p.base), p);
      else put("~ctl", ch ? "Common" : "Control", p);
    }
    let list = [...groups.values()].sort((a, b) => byNatural(a.key, b.key));
    if (explicit) {
      const shared = list.filter(g => g.key === "g000").flatMap(g => g.pins);
      list = list.filter(g => g.key !== "g000");
      return {gates: list, shared};
    }
    const power = list.find(g => g.key === "~power");
    list = list.filter(g => g !== power);
    if (list.length > 25) { const rest = list.splice(24); list.push({key: "~more", label: "Other", pins: rest.flatMap(g => g.pins)}); }
    let shared = [];
    if (power) { if (o.power === "shared" && list.length) shared = power.pins; else list.push(power); }
    return {gates: list, shared};
  }
  // Pins -> editor model. layout: "function" | "gates" | "package" (preset dual|quad|single).
  function layout(all, o = {}) {
    const pins = all.filter(p => p.include !== false);
    const opts = {pitch: o.pitch || G, length: o.length || 2 * G};
    if (o.layout === "package") { const r = place(sidesByPackage(pins, o.preset), opts); return {pins: r.pins, shapes: r.shapes, parts: 1, alternate: false}; }
    if (o.layout !== "gates") { const r = place(sidesByFunction(pins), opts); return {pins: r.pins, shapes: r.shapes, parts: 1, alternate: false}; }
    const {gates, shared} = gatesOf(pins, o);
    if (gates.length <= 1 && !shared.length) { const r = place(sidesByFunction(pins), opts); return {pins: r.pins, shapes: r.shapes, parts: 1, alternate: false}; }
    const sharedPins = shared.map(p => ({...p, shared: true}));
    const sidesFor = g => sidesByFunction([...g.pins, ...sharedPins]);
    // Shared pins sit at the same place on every gate, so every gate gets the same body.
    let minWidth = 0, minHeight = 0;
    if (sharedPins.length) for (const g of gates) { const r = place(sidesFor(g), opts); minWidth = Math.max(minWidth, r.width); minHeight = Math.max(minHeight, r.height); }
    const model = {pins: [], shapes: [], parts: gates.length, alternate: false, gateLabels: gates.map(g => g.label)};
    gates.forEach((g, i) => {
      const r = place(sidesFor(g), {...opts, part: i + 1, minWidth, minHeight});
      for (const p of r.pins) if (p.part !== 0 || i === 0) model.pins.push(p);
      model.shapes.push(...r.shapes);
    });
    return model;
  }
  // Pins -> library def (not yet in any project).
  function build(pins, o = {}) {
    const L = Lib(), model = layout(pins, o);
    const extra = model.pins.map(p => ({noConnect: p.noConnect, alternates: p.alternates}));
    const b = L.buildSymbol({...model, pins: model.pins.map(({key, noConnect, alternates, ...p}) => { void key; void noConnect; void alternates; return p; })});
    b.symbol.pins.forEach((p, i) => { if (extra[i].noConnect) p.noConnect = true; if (extra[i].alternates?.length) p.alternates = extra[i].alternates.slice(); });
    const A = globalThis.Atrium;
    const def = {id: o.id || A.id(), name: String(o.name || "New component").trim() || "New component", prefix: o.prefix || "U", value: o.value ?? "", category: o.category || "Project components", symbol: b.symbol};
    if (b.schDrawing) def.schDrawing = b.schDrawing;
    if (o.description) def.description = String(o.description);
    if (o.footprint) def.footprint = JSON.parse(JSON.stringify(o.footprint));
    return {def, model};
  }

  // ------------------------------------------------------------------ existing symbols
  const TYPE_NAME = e => Lib().ELECTRICAL[e ?? 4];
  // Not a spreadsheet export: this table is read back by detect(), so pin names stay verbatim (no formula guard).
  const cell = v => /[\t\n"]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  // Hidden pins keep a Hidden column (the source table's hidden role, as kicadSymbols writes), so they stay hidden.
  function tableFromDef(def) {
    const pins = def?.symbol?.pins || [], gates = (def?.symbol?.parts || 1) > 1, hidden = pins.some(p => p.hidden);
    const lines = [["Number", "Name", "Type", "Alternates", ...(gates ? ["Gate"] : []), ...(hidden ? ["Hidden"] : [])].join("\t")];
    for (const p of pins) lines.push([p.number, p.name || "", p.noConnect ? "NC" : TYPE_NAME(p.electrical), (p.alternates || []).join(", "), ...(gates ? [p.part ?? 0] : []), ...(hidden ? [p.hidden ? "yes" : ""] : [])].map(cell).join("\t"));
    return lines.join("\n");
  }
  const KICAD_TYPE = {input: "Input", output: "Output", bidirectional: "I/O", tri_state: "HiZ", passive: "Passive", free: "Passive", unspecified: "Passive",
    power_in: "Power", power_out: "Power", open_collector: "Open Collector", open_emitter: "Open Emitter", no_connect: "NC"};
  // KiCad 6–9 .kicad_sym (publicly documented S-expression format) -> [{name, text, pins}].
  function kicadSymbols(text) {
    const S = globalThis.AtriumSexpr || (() => { throw Error("The KiCad reader is not loaded."); })();
    const t = S.parse(String(text));
    if (t[0] !== "kicad_symbol_lib") throw Error("This is not a KiCad symbol library (kicad_symbol_lib).");
    const out = [];
    for (const sym of S.all(t, "symbol")) {
      const name = String(sym[1] ?? ""), rows = [];
      const walk = (node, unit) => {
        for (const p of S.all(node, "pin")) {
          const number = String(S.val(p, "number") ?? ""), pname = String(S.val(p, "name") ?? "");
          rows.push({number, name: pname === "~" ? "" : pname, type: KICAD_TYPE[p[1]] || "Passive", unit, hidden: S.flag(p, "hide")});
        }
      };
      walk(sym, 0);
      for (const sub of S.all(sym, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(String(sub[1] ?? "")); if (m && +m[2] > 1) continue; walk(sub, m ? +m[1] : 0); }
      const units = new Set(rows.map(r => r.unit).filter(u => u > 0));
      const extends_ = S.val(sym, "extends");
      if (!rows.length && !extends_) continue;
      const gates = units.size > 1;
      const lines = [["Number", "Name", "Type", ...(gates ? ["Gate"] : []), "Hidden"].join("\t")];
      for (const r of rows) lines.push([r.number, r.name, r.type, ...(gates ? [r.unit] : []), r.hidden ? "yes" : ""].map(cell).join("\t"));
      out.push({name, text: rows.length ? lines.join("\n") : "", pins: rows.length, extends: extends_ ? String(extends_) : null});
    }
    // A derived symbol (extends "Parent") has its parent's pins: KiCad lets it change fields, not pins.
    // Same file only, at most 8 levels, as library-import-kicad.js; a missing or circular parent stays empty.
    const byName = new Map(out.map(s => [s.name, s]));
    for (const s of out) {
      if (s.text || !s.extends) continue;
      let parent = byName.get(s.extends);
      for (let depth = 0; parent && !parent.text && parent.extends && depth < 8; depth++) parent = byName.get(parent.extends);
      if (parent?.text) { s.text = parent.text; s.pins = parent.pins; }
    }
    return out;
  }
  // A picked file -> {kind:"table", text} or {kind:"library", symbols:[{name, text, pins}]}.
  async function readFile(file) {
    const name = String(file?.name || ""), lower = name.toLowerCase();
    const bytes = async () => file.arrayBuffer ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(await file.text());
    const text = async () => file.text ? file.text() : new TextDecoder().decode(await bytes());
    if (lower.endsWith(".kicad_sym")) {
      if (!globalThis.AtriumSexpr && globalThis.AtriumLazy) await AtriumLazy.need("AtriumImportFormats");
      return {kind: "library", symbols: kicadSymbols(await text())};
    }
    if (lower.endsWith(".schlib") || lower.endsWith(".schdoc")) {
      if (globalThis.AtriumLazy && (!globalThis.AtriumSCH || !globalThis.AtriumIO?.read)) await AtriumLazy.need("AtriumImport");
      const r = AtriumIO.read(name, await bytes());
      return {kind: "library", symbols: (r.library || []).filter(d => d.symbol?.pins?.length).map(d => ({name: d.name, text: tableFromDef(d), pins: d.symbol.pins.length}))};
    }
    if (/\.(xlsx?|ods|numbers)$/.test(lower)) throw Error("Save the sheet as CSV (File › Export or Save As › CSV) and import the .csv.");
    return {kind: "table", text: await text()};
  }

  // ------------------------------------------------------------------ samples (written for Waffle)
  // Three made-up parts in three datasheet styles, for trying the wizard and for the tests.
  const SAMPLES = {
    mcu: {name: "ATR32F010 MCU (32 pins)", prefix: "U", style: "PDF text", text: [
      "Pin name Pin Type", "VBAT 1 S", "PC14 / OSC32_IN 2 I/O", "PC15 / OSC32_OUT 3 I/O", "NRST 4 I/O", "VDDA 5 S", "PA0 / ADC_IN0 / WKUP 6 I/O",
      "PA1 / ADC_IN1 7 I/O", "PA2 / USART2_TX / ADC_IN2 8 I/O", "PA3 / USART2_RX / ADC_IN3 9 I/O", "PA4 / SPI1_NSS / ADC_IN4 10 I/O", "PA5 / SPI1_SCK 11 I/O",
      "PA6 / SPI1_MISO 12 I/O", "PA7 / SPI1_MOSI 13 I/O", "PB0 / ADC_IN8 14 I/O", "PB1 / ADC_IN9 15 I/O", "VSS 16 S", "VDD 17 S", "PB2 / BOOT1 18 I/O",
      "PB6 / I2C1_SCL 19 I/O", "PB7 / I2C1_SDA 20 I/O", "PA8 / MCO 21 I/O", "PA9 / USART1_TX 22 I/O", "PA10 / USART1_RX 23 I/O", "PA11 / USB_DM 24 I/O",
      "PA12 / USB_DP 25 I/O", "PA13 / SWDIO 26 I/O", "PA14 / SWCLK 27 I/O", "PA15 / JTDI 28 I/O", "BOOT0 29 I", "VSS 30 S", "VDD 31 S", "NC 32 -"].join("\n")},
    opamp: {name: "ATR6002 dual op amp", prefix: "U", style: "tab-separated", text: [
      "Pin\tName\tType\tDescription", "1\tOUTA\tO\tOutput, channel A", "2\t-INA\tI\tInverting input, channel A", "3\t+INA\tI\tNon-inverting input, channel A",
      "4\tV-\tP\tNegative supply", "5\t+INB\tI\tNon-inverting input, channel B", "6\t-INB\tI\tInverting input, channel B", "7\tOUTB\tO\tOutput, channel B",
      "8\tV+\tP\tPositive supply"].join("\n")},
    ldo: {name: "ATR1150 300 mA LDO", prefix: "U", style: "CSV", text: [
      "Name,Pin,I/O,Function", "VIN,1,P,\"Input supply, 2.5 V to 6 V\"", "GND,2,-,Ground", "EN,3,I,Enable (high = on)", "NC,4,-,Not connected",
      "PG#,5,OD,\"Power good, open drain\"", "VOUT,6,P,Regulated output", "EP,7,-,\"Exposed pad, connect to GND\""].join("\n")}
  };

  // ------------------------------------------------------------------ MCP
  const ok = (v, list, d) => list.includes(v) ? v : d;
  function headless(a = {}, ctx) {
    const L = Lib() || (() => { throw Error("The library module is not loaded."); })();
    const text = String(a.table ?? "");
    if (!text.trim()) throw Error("Give the pin table as text (table).");
    const t = detect(text, {mode: ok(a.delimiter, ["auto", "tab", "csv", "semicolon", "columns", "space"], "auto"), header: typeof a.header === "boolean" ? a.header : undefined});
    let roles = t.roles.slice();
    if (a.columns && typeof a.columns === "object") {
      for (const [role, i] of Object.entries(a.columns)) {
        if (!UNIQUE.has(role) && role !== "description") throw Error("Unknown column role " + JSON.stringify(role).slice(0, 40) + ".");
        if (!Number.isInteger(i) || i < 0 || i >= t.columns) throw Error("Column " + role + " must be 0.." + (t.columns - 1) + ".");
        roles = roles.map(r => r === role ? "ignore" : r); roles[i] = role;
      }
    }
    const style = ok(a.active_low, ["overbar", "altium", "keep"], "overbar");
    const {pins, notes} = pinsOf(t, {roles, smart: a.smart_typing !== false, split: a.split_names !== false, activeLow: style});
    const p = ctx.mutable();
    const fpDef = a.footprint_def_id ? p.library.find(d => d.id === a.footprint_def_id || d.name === a.footprint_def_id) : null;
    if (a.footprint_def_id && !fpDef?.footprint) throw Error("The library has no footprint " + String(a.footprint_def_id).slice(0, 80) + ".");
    const issues = [...check(pins, {footprint: fpDef?.footprint}), ...notes];
    const errors = issues.filter(x => x.level === "error");
    if (errors.length) throw Error(errors[0].message + (errors.length > 1 ? " (" + (errors.length - 1) + " more)" : ""));
    const base = a.def_id ? p.library.find(d => d.id === a.def_id) || (() => { throw Error("The library has no definition " + String(a.def_id).slice(0, 80) + "."); })() : null;
    const o = {layout: ok(a.layout, ["function", "gates", "package"], "function"), preset: ok(a.package, ["dual", "quad", "single", "single-right"], "dual"),
      pitch: a.pitch === 5.08 ? 5.08 : G, length: [2.54, 5.08, 7.62].includes(a.pin_length) ? a.pin_length : 2 * G, power: ok(a.power_pins, ["separate", "shared"], "separate"),
      name: a.name || base?.name || "New component", prefix: a.prefix || base?.prefix || "U", value: a.value ?? base?.value ?? "", description: a.description ?? base?.description,
      footprint: fpDef?.footprint || base?.footprint, id: base?.id};
    const {def} = build(pins, o);
    if (base) for (const k of ["category", "parameters", "model3d", "libraryRef"]) if (base[k] != null && def[k] == null) def[k] = base[k];
    if (a.parameters && typeof a.parameters === "object") def.parameters = {...a.parameters};
    const report = L.replaceDef(p, def);
    ctx.touched();
    const used = pins.filter(x => x.include !== false), count = k => used.filter(x => kind(x) === k).length;
    return {def_id: def.id, pins: def.symbol.pins.length, gates: def.symbol.parts || 1, layout: o.layout, added: report.added, parts_updated: report.parts,
      detected: {mode: t.mode, header: t.header, columns: roles},
      counts: {power: count("power"), ground: count("ground"), input: count("input"), output: count("output"), io: count("io"), passive: count("passive"), no_connect: count("nc"), active_low: used.filter(x => x.low).length},
      warnings: issues.filter(x => x.level === "warning").length,
      untrusted_design_text: {name: def.name, headers: t.headers, issues: issues.map(x => ({level: x.level, code: x.code, message: x.message})), footprint: def.footprint?.name || null,
        pin_list: def.symbol.pins.slice(0, 500).map(x => ({number: x.number, name: x.name, type: x.noConnect ? "No connect" : L.ELECTRICAL[x.electrical ?? 4], side: x.orientation, gate: x.part || 0,
          ...(x.alternates ? {alternates: x.alternates} : {})}))}};
  }

  // ------------------------------------------------------------------ dialog
  function footprintChoices(library, pins) {
    const C = globalThis.AtriumCatalogue, ids = new Set(library.map(d => d.id));
    let defs = library.filter(d => d.footprint && !d.mirrorOf && !(C && C.hidden(d, ids)));
    if (C) defs = C.uniqueFootprints(defs);
    else { const seen = new Set(); defs = defs.filter(d => { const k = (d.footprint.name || d.name) + "|" + JSON.stringify((d.footprint.pads || []).map(Atrium.terminalGeometry)); if (seen.has(k)) return false; seen.add(k); return true; }); }
    const out = defs.map(d => ({id: d.id, footprint: d.footprint, name: d.footprint.name || d.name, pads: new Set((d.footprint.pads || []).filter(p => !p.thermalVia).map(p => String(p.number))).size, part: d.name}));
    const byName = new Map(); for (const o of out) byName.set(o.name, (byName.get(o.name) || 0) + 1);
    for (const o of out) { const n = o.pads + (o.pads === 1 ? " pad" : " pads"); o.label = byName.get(o.name) > 1 ? o.name + " (" + n + ", " + o.part + ")" : o.name + " · " + n; o.match = o.pads === pins; }
    return out.sort((a, b) => b.match - a.match || a.label.localeCompare(b.label, "en", {numeric: true, sensitivity: "base"}));
  }

  function open(ctx = {}) {
    const L = Lib(), ui = L.ui, el = ui.el;
    if (!globalThis.AtriumCatalogue) globalThis.AtriumLazy?.need?.("AtriumCatalogue")?.catch?.(() => {});
    const project = () => ctx.currentProject ? ctx.currentProject() : ctx.project;
    const library = () => ctx.library || project()?.library || [];
    const applying = typeof ctx.apply === "function";
    const st = {text: ctx.text || "", mode: "auto", header: undefined, roles: null, edits: {}, layout: "function", preset: "dual", pitch: G, length: 2 * G, power: "separate",
      activeLow: "overbar", smart: true, split: true, units: "mm", name: ctx.name || "", prefix: ctx.prefix || "U", value: "", description: "", footprint: "", gate: 1};
    let table = null, result = {pins: [], notes: []}, issues = [], made = null, error = "";
    const dlg = ui.dialog("Symbol Wizard", "sw-dialog");

    // ---- source
    const src = el("section", null, "sw-source");
    const ta = el("textarea", null, "sw-paste"); ta.rows = 7; ta.spellcheck = false; ta.value = st.text; ta.setAttribute("aria-label", "Pin table");
    ta.placeholder = "Paste a pin table from a datasheet or spreadsheet: tab, comma or space separated.\n1 VDD power\nPA0 / ADC_IN0 12 I/O\n3\tnRESET\tinput";
    const sample = el("select"); sample.setAttribute("aria-label", "Sample table"); sample.add(new Option("Sample…", ""));
    for (const [k, s] of Object.entries(SAMPLES)) sample.add(new Option(s.name + " (" + s.style + ")", k));
    sample.onchange = () => { const s = SAMPLES[sample.value]; if (!s) return; st.text = ta.value = s.text; st.name = s.name; st.prefix = s.prefix; st.roles = null; st.edits = {}; st.header = undefined; sample.value = ""; syncMeta(); recompute(true); };
    const importBtn = ui.button("Import file…", () => importFile(), "lib-mini"); importBtn.title = "CSV or TSV (also a spreadsheet saved as CSV), KiCad .kicad_sym, or the components of an Altium SchLib or SchDoc";
    const modeSel = el("select"); modeSel.setAttribute("aria-label", "Split columns by");
    for (const [v, t] of [["auto", "Columns: auto"], ["tab", "Tab"], ["csv", "Comma"], ["semicolon", "Semicolon"], ["columns", "Two or more spaces"], ["space", "Spaces (PDF text)"]]) modeSel.add(new Option(t, v));
    modeSel.onchange = () => { st.mode = modeSel.value; st.roles = null; recompute(true); };
    const headChk = el("input"); headChk.type = "checkbox"; headChk.setAttribute("aria-label", "First row is a header");
    headChk.onchange = () => { st.header = headChk.checked; st.roles = null; recompute(true); };
    const headLbl = el("label", null, "sw-check"); headLbl.append(headChk, el("span", "Header row"));
    const libPick = el("select"); libPick.hidden = true; libPick.setAttribute("aria-label", "Symbol in the library file");
    const srcBar = el("div", null, "sw-bar"); srcBar.append(importBtn, sample, libPick, el("span", null, "sw-grow"), modeSel, headLbl);
    const detected = el("p", null, "sw-detected"); detected.setAttribute("role", "status");
    const mapping = el("div", null, "sw-mapping"); mapping.setAttribute("aria-label", "Column roles");
    src.append(srcBar, ta, detected, mapping);
    let typing = 0;
    ta.oninput = () => { clearTimeout(typing); typing = setTimeout(() => { st.text = ta.value; st.edits = {}; recompute(true); }, 180); };
    async function importFile() {
      const pick = ctx.pickFile || globalThis.AtriumIO?.pickFile;
      if (!pick) { error = "This build has no file chooser."; renderIssues(); return; }
      try {
        const f = await pick([".csv", ".tsv", ".txt", ".kicad_sym", ".SchLib", ".schlib", ".SchDoc", ".schdoc"]);
        if (!f) return;
        const r = await readFile(f);
        libPick.hidden = true;
        if (r.kind === "table") { setText(r.text, String(f.name || "").replace(/\.[^.]+$/, "")); return; }
        const usable = r.symbols.filter(s => s.text);
        if (!usable.length) throw Error("The library has no symbols with pins.");
        libPick.replaceChildren(...usable.map((s, i) => new Option(s.name + " · " + s.pins + " pins", String(i))));
        libPick.hidden = usable.length < 2;
        libPick.onchange = () => { const s = usable[+libPick.value]; setText(s.text, s.name); };
        setText(usable[0].text, usable[0].name);
      } catch (e) { error = e.message; renderIssues(); }
    }
    function setText(text, name) { st.text = ta.value = text; if (name) st.name = name; st.roles = null; st.edits = {}; st.header = undefined; st.mode = "auto"; modeSel.value = "auto"; error = ""; syncMeta(); recompute(true); }

    // ---- pin grid
    const gridWrap = el("div", null, "sw-grid-wrap"), grid = el("table", null, "sw-grid ui-sheet-fields"); gridWrap.append(grid);
    const issueBox = el("div", null, "sw-issues"); issueBox.setAttribute("aria-live", "polite");
    const left = el("div", null, "sw-left"); left.append(src, gridWrap, issueBox);

    // ---- options and preview
    const right = el("div", null, "sw-right"), opts = el("div", null, "sw-options");
    const input = (label, key, ph) => { const i = el("input"); i.value = st[key]; i.placeholder = ph || ""; i.spellcheck = false; i.oninput = () => { st[key] = i.value; schedule(); }; return ui.label(label, i); };
    const metaRow = el("div", null, "sw-meta");
    metaRow.append(input("Name", "name", "New component"), input("Prefix", "prefix", "U"), input("Value", "value"), input("Description", "description"));
    function syncMeta() { const f = metaRow.querySelectorAll("input"); f[0].value = st.name; f[1].value = st.prefix; }
    const layoutBar = el("div", null, "sw-seg ui-segmented"); layoutBar.setAttribute("role", "group"); layoutBar.setAttribute("aria-label", "Layout");
    for (const [k, t, title] of [["function", "By function", "One body: power on top, ground at the bottom, inputs left, outputs right, ports grouped"],
      ["gates", "Gates by group", "One gate per channel or port, a control gate and a power gate"], ["package", "Package sides", "Pins around the body in pin-number order"]]) {
      const b = el("button", t, "ui-segment"); b.type = "button"; b.dataset.layout = k; b.title = title;
      b.onclick = () => { st.layout = k; st.gate = 1; recompute(true); }; layoutBar.append(b);
    }
    const sel = (label, key, values, num) => { const s = el("select"); for (const [v, t] of values) s.add(new Option(t, String(v))); s.value = String(st[key]); s.onchange = () => { st[key] = num ? +s.value : s.value; recompute(true); }; return ui.label(label, s); };
    const presetRow = sel("Sides", "preset", [["dual", "Dual (DIP, SOIC)"], ["quad", "Quad (QFP, QFN)"], ["single", "Single, left"], ["single-right", "Single, right"]]);
    const powerRow = sel("Power pins", "power", [["separate", "Own power gate"], ["shared", "On every gate"]]);
    const unitRow = sel("Units", "units", [["mm", "mm"], ["mil", "mil"]]);
    const pitchRow = el("div"), lengthRow = el("div");
    function gridSelects() {
      const f = v => st.units === "mil" ? Math.round(v / .0254) + " mil" : v.toFixed(2) + " mm";
      pitchRow.replaceChildren(sel("Pin spacing", "pitch", [[2.54, f(2.54) + " grid"], [5.08, f(5.08)]], true));
      lengthRow.replaceChildren(sel("Pin length", "length", [[2.54, f(2.54)], [5.08, f(5.08)], [7.62, f(7.62)]], true));
    }
    const lowRow = sel("Active-low names", "activeLow", [["overbar", "Overbar (R̅E̅S̅E̅T̅)"], ["altium", "Altium notation (R\\E\\S\\E\\T\\)"], ["keep", "Keep as typed"]]);
    const flag = (text, key, title) => { const c = el("input"); c.type = "checkbox"; c.checked = st[key]; c.onchange = () => { st[key] = c.checked; recompute(); }; const l = el("label", null, "sw-check"); l.title = title; l.append(c, el("span", text)); return l; };
    const flags = el("div", null, "sw-flags");
    flags.append(flag("Smart typing", "smart", "GND, VSS, VDD and VCC are power and NC is no-connect, whatever the type column says"),
      flag("Split “A / B” names", "split", "PA0 / ADC_IN0 becomes pin PA0 with alternate function ADC_IN0"));
    const layoutOpts = el("div", null, "sw-grid2");
    layoutOpts.append(presetRow, powerRow, pitchRow, lengthRow, unitRow, lowRow);
    const fpSel = el("select"); fpSel.setAttribute("aria-label", "Footprint");
    fpSel.onchange = () => { st.footprint = fpSel.value; recompute(); };
    const fpNote = el("p", null, "sw-note");
    const fpBox = el("div", null, "sw-footprint"); fpBox.append(ui.label("Footprint", fpSel), fpNote);
    opts.append(metaRow, layoutBar, layoutOpts, flags, ...(applying ? [] : [fpBox]));
    const gates = el("div", null, "sw-gates");
    const canvas = el("canvas", null, "sw-canvas"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Symbol preview");
    const facts = el("p", null, "sw-note");
    const previewBox = el("div", null, "sw-preview"); previewBox.append(gates, canvas, facts);
    right.append(opts, previewBox);
    const FG = globalThis.AtriumSymbolEditor?.filterGate || (s => s);
    const stage = ui.stage(canvas, {kind: "schematic", def: () => made ? {...made.def, symbol: FG(made.def.symbol, st.gate, false)} : null, item: () => ({part: st.gate, alt: false})});
    canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Symbol preview");
    ui.shortcut(canvas, "Fit the symbol preview", "F", " or double-click");
    canvas.addEventListener("dblclick", () => stage.fit());
    // The preview refits when its box changes size, until the user zooms or pans it.
    let userView = false, refit = 0;
    canvas.addEventListener("wheel", () => { userView = true; }, {passive: true});
    canvas.addEventListener("pointerdown", e => { if (e.button !== 0) userView = true; });
    const fitSoon = () => { clearTimeout(refit); refit = setTimeout(() => { if (canvas.isConnected) stage.fit(); }, 30); };
    if (globalThis.ResizeObserver) new ResizeObserver(() => { if (!userView) fitSoon(); }).observe(canvas);
    canvas.addEventListener("keydown", e => { if (e.key === "f" || e.key === "F") { e.preventDefault(); stage.fit(); } });

    const body = el("div", null, "sw-body"); body.append(left, right);
    const footer = el("div", null, "lib-actions"), status = el("span", null, "sw-status");
    const primary = ui.button(applying ? "Apply to symbol" : "Create in Symbol Editor", () => finish(true), "lib-primary");
    ui.shortcut(primary, primary.textContent, "Mod+Enter");
    const add = ui.button("Add to library", () => finish(false));
    footer.append(status, ui.button("Cancel", () => dlg.close()), ...(applying ? [] : [add]), primary);
    dlg.append(body, footer);

    // ---- recompute
    const E = L.ELECTRICAL;
    let pending = 0;
    function schedule() { clearTimeout(pending); pending = setTimeout(() => recompute(), 120); }
    function recompute(fit) {
      error = "";
      try { table = detect(st.text, {mode: st.mode, header: st.header}); }
      catch (e) { table = {mode: st.mode, header: false, headers: null, columns: 0, cells: [], roles: []}; error = e.message; }
      if (st.roles && st.roles.length !== table.columns) st.roles = null;
      result = pinsOf(table, {roles: st.roles || table.roles, smart: st.smart, split: st.split, activeLow: st.activeLow, edits: st.edits});
      const fp = library().find(d => d.id === st.footprint)?.footprint;
      issues = [...(st.text.trim() ? check(result.pins, {footprint: fp}) : []), ...result.notes];
      made = null;
      if (result.pins.some(p => p.include !== false)) {
        try { made = build(result.pins, {layout: st.layout, preset: st.preset, pitch: st.pitch, length: st.length, power: st.power, name: st.name || "New component", prefix: st.prefix || "U", value: st.value, description: st.description, footprint: fp}); }
        catch (e) { error = e.message; }
      }
      if (made && (made.def.symbol.parts || 1) < st.gate) st.gate = 1;
      renderMapping(); renderGrid(); renderIssues(); renderOptions(); renderFootprints();
      if (fit) { userView = false; fitSoon(); } else stage.render();
    }
    function renderMapping() {
      headChk.checked = !!table.header;
      const roles = st.roles || table.roles;
      const modeName = {tab: "tab-separated", csv: "comma-separated", semicolon: "semicolon-separated", columns: "column-aligned text", space: "space-separated PDF text"}[table.mode] || table.mode;
      detected.textContent = st.text.trim() ? "Detected " + modeName + (table.header ? " with a header row" : "") + " · " + table.cells.length + " row" + (table.cells.length === 1 ? "" : "s") + " → " + result.pins.length + " pin" + (result.pins.length === 1 ? "" : "s") : "";
      mapping.replaceChildren();
      if (!table.columns) return;
      for (let i = 0; i < table.columns; i++) {
        const s = el("select"); for (const r of ROLES) s.add(new Option(ROLE_LABEL[r], r)); s.value = roles[i] || "ignore";
        const head = table.mode === "space" ? ["Number", "Name", "Type", "Alternates", "Description"][i] : table.headers?.[i] || "Column " + (i + 1);
        const first = table.cells.find(r => r[i])?.[i] || "";
        s.setAttribute("aria-label", "Role of " + head);
        s.onchange = () => { const next = roles.slice(); if (UNIQUE.has(s.value)) next.forEach((r, k) => { if (r === s.value && k !== i) next[k] = "ignore"; }); next[i] = s.value; st.roles = next; st.edits = {}; recompute(true); };
        const chip = el("label", null, "sw-col" + (s.value === "ignore" ? " is-off" : "")); chip.title = head + (first ? " · e.g. " + first : "");
        chip.append(el("span", head, "sw-col-head"), s); mapping.append(chip);
      }
    }
    const issueOf = new Map();
    function renderGrid() {
      issueOf.clear();
      for (const x of issues) for (const k of x.keys || []) { const cur = issueOf.get(k); if (!cur || rank(x.level) > rank(cur.level)) issueOf.set(k, x); }
      grid.replaceChildren();
      const head = el("tr");
      for (const t of ["", "Number", "Name", "Low", "Type", "Alternate functions", "Side", "Gate"]) head.append(el("th", t));
      const thead = el("thead"); thead.append(head); grid.append(thead);
      const tbody = el("tbody");
      const edit = (p, k, v) => { (st.edits[p.key] ||= {})[k] = v; recompute(); };
      for (const p of result.pins.slice(0, 2000)) {
        const tr = el("tr"), x = issueOf.get(p.key);
        tr.dataset.key = p.key;
        if (x) { tr.className = "sw-" + x.level; tr.title = x.message; }
        if (p.include === false) tr.classList.add("is-off");
        const td = () => { const c = el("td"); tr.append(c); return c; };
        const inc = el("input"); inc.type = "checkbox"; inc.checked = p.include !== false; inc.setAttribute("aria-label", "Include pin " + p.number); inc.onchange = () => edit(p, "include", inc.checked); td().append(inc);
        const text = (k, v, label, cls) => { const i = el("input"); i.value = v; i.spellcheck = false; i.setAttribute("aria-label", label); if (cls) i.className = cls; i.onchange = () => edit(p, k, i.value); td().append(i); return i; };
        text("number", p.number, "Number of pin " + (p.row + 1), "sw-num");
        text("name", p.typed, "Name of pin " + p.number);
        const low = el("input"); low.type = "checkbox"; low.checked = p.low; low.title = "Active low: drawn with an overbar"; low.setAttribute("aria-label", "Active low pin " + p.number); low.onchange = () => edit(p, "low", low.checked); td().append(low);
        const ty = el("select"); for (const [v, t] of [...E.map((t, i) => [String(i), t]), ["nc", "No connect"]]) ty.add(new Option(t, v)); ty.value = p.nc ? "nc" : String(p.electrical);
        ty.setAttribute("aria-label", "Type of pin " + p.number); ty.onchange = () => edit(p, "type", ty.value); td().append(ty);
        text("alternates", p.alternates.join(", "), "Alternate functions of pin " + p.number, "sw-alt");
        const side = el("select"); for (const [v, t] of [["auto", "Auto"], ["left", "Left"], ["right", "Right"], ["top", "Top"], ["bottom", "Bottom"]]) side.add(new Option(t, v)); side.value = p.side || "auto";
        side.setAttribute("aria-label", "Side of pin " + p.number); side.onchange = () => edit(p, "side", side.value); td().append(side);
        const g = el("input"); g.value = p.part ?? ""; g.placeholder = "auto"; g.className = "sw-gate"; g.setAttribute("aria-label", "Gate of pin " + p.number);
        g.onchange = () => { const v = g.value.trim(); edit(p, "part", v === "" ? undefined : /^[A-Z]$/i.test(v) ? v.toUpperCase().charCodeAt(0) - 64 : parseInt(v, 10)); }; td().append(g);
        tbody.append(tr);
      }
      grid.append(tbody);
      gridWrap.hidden = !result.pins.length;
    }
    const rank = l => l === "error" ? 3 : l === "warning" ? 2 : 1;
    function renderIssues() {
      issueBox.replaceChildren();
      const list = [...(error ? [{level: "error", code: "parse", message: error, keys: []}] : []), ...issues].sort((a, b) => rank(b.level) - rank(a.level));
      const errors = list.filter(x => x.level === "error").length, warnings = list.filter(x => x.level === "warning").length;
      if (!list.length && !result.pins.length) { issueBox.append(el("p", "Paste a pin table above, import a file, or try a sample.", "ui-empty sw-empty")); }
      if (list.length) {
        const ul = el("ul");
        for (const x of list.slice(0, 40)) {
          const li = el("li", null, "lvl-" + x.level), b = ui.button(x.message, () => { const k = x.keys?.[0]; const tr = k && grid.querySelector('tr[data-key="' + k + '"]'); if (tr) { tr.scrollIntoView?.({block: "nearest"}); tr.querySelector("input:not([type=checkbox])")?.focus(); } });
          b.className = "sw-issue"; li.append(b); ul.append(li);
        }
        issueBox.append(ul);
      }
      status.textContent = errors ? errors + " error" + (errors > 1 ? "s" : "") + " to fix" : warnings ? warnings + " warning" + (warnings > 1 ? "s" : "") : result.pins.length ? "Checks pass" : "";
      status.className = "sw-status " + (errors ? "is-error" : warnings ? "is-warning" : "is-ok");
      primary.disabled = add.disabled = !!errors || !made;
    }
    function renderOptions() {
      for (const b of layoutBar.children) b.setAttribute("aria-pressed", String(b.dataset.layout === st.layout));
      presetRow.hidden = st.layout !== "package"; powerRow.hidden = st.layout !== "gates";
      gridSelects();
      gates.replaceChildren();
      const n = made?.def.symbol.parts || 1;
      if (n > 1) for (let g = 1; g <= n; g++) { const b = ui.button(String.fromCharCode(64 + g) + (made.model.gateLabels?.[g - 1] ? " · " + made.model.gateLabels[g - 1] : ""), () => { st.gate = g; renderOptions(); stage.fit(); }, "lib-chip"); b.setAttribute("aria-pressed", String(g === st.gate)); gates.append(b); }
      const pins = result.pins.filter(p => p.include !== false), k = c => pins.filter(p => kind(p) === c).length;
      facts.textContent = made ? pins.length + " pins · " + n + (n === 1 ? " gate" : " gates") + " · " + [["power", k("power") + k("ground")], ["in", k("input")], ["out", k("output")], ["I/O", k("io")], ["passive", k("passive")], ["NC", k("nc")], ["active low", pins.filter(p => p.low).length]].filter(x => x[1]).map(x => x[1] + " " + x[0]).join(", ") : "";
    }
    let fpCount = -1;
    function renderFootprints() {
      if (applying) return;
      const n = new Set(result.pins.filter(p => p.include !== false).map(p => p.number)).size;
      if (n !== fpCount || fpSel.options.length <= 1) {
        fpCount = n;
        const list = footprintChoices(library(), n), keep = st.footprint;
        fpSel.replaceChildren(new Option("— none —", ""));
        const match = list.filter(x => x.match), rest = list.filter(x => !x.match);
        const group = (label, items) => { if (!items.length) return; const g = el("optgroup"); g.label = label; for (const x of items) g.append(new Option(x.label, x.id)); fpSel.append(g); };
        group(n + " pads, matching the pins", match); group(match.length ? "Other footprints" : "Footprints", rest);
        fpSel.value = list.some(x => x.id === keep) ? keep : "";
        st.footprint = fpSel.value;
      }
      const d = library().find(x => x.id === st.footprint);
      fpNote.textContent = d ? "Linked to " + (d.footprint.name || d.name) + ". The Symbol Editor shows it under Footprint." : "Footprints with " + n + " pads are listed first. You can also choose one later in the Symbol Editor.";
    }
    function finish(edit) {
      recompute();
      if (!made || issues.some(x => x.level === "error")) return;
      const def = made.def;
      if (applying) { ctx.apply({pins: made.model.pins.map(({key, ...p}) => { void key; return p; }), shapes: made.model.shapes, parts: made.model.parts}, def); dlg.close(); return; }
      const v = L.validateDef(def, {footprintWarnings: false});
      if (!v.ok) { error = v.errors[0]; renderIssues(); return; }
      dlg.close();
      if (edit) { if (L.openSymbolEditor) L.openSymbolEditor(ctx, def); else globalThis.AtriumSymbolEditor?.open({def, library: library(), info: ctx.info, commit: d => L.commitDef(ctx, d)}); }
      else L.commitDef(ctx, def);
    }
    dlg.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); finish(true); } });
    ui.show(dlg);
    recompute(true);
    stage.observe();
    if (!st.text) ta.focus();
    return {dialog: dlg, state: st, result: () => ({table, pins: result.pins, issues, def: made?.def || null}), setText, recompute, finish};
  }

  const workflows = {"symbol-wizard": {open: ctx => open(ctx)}};
  return Object.freeze({detect, pinsOf, check, layout, build, activeLow, styleName, typeCode, channels, portKey, kind, tableFromDef, kicadSymbols, readFile, headless, open, workflows, SAMPLES});
})();
