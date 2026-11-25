"use strict";
// Net intent index (docs/design/net-intent.md §4–§6, phases P1/P2): what the project's nets say, with the
// evidence behind it, for suggestions (Signals panel), learned naming conventions (the Naming view), name
// completion and the intent insights (insights-intent.js). net-intent.js reads one name; this module reads
// the project. DOM-free, deterministic, lazy (loaded with AtriumNetIntent).
//
//   facts(project, defs?) -> F   per document, memoised on the undo journal (AtriumUndoStore):
//     a schematic sheet is re-read only when one of its electrical objects changed, a board part is patched
//     alone; F = {names: Map(name -> {n, power, port, label, wire, board, items}), pins: Map(net -> [pin]),
//     boardPins, twoPin, aliases, gen}
//   conventions(project, F?) -> {stored, learned: [card], effective}   learned = §6.2 inference
//   classify(name, effective?) -> reading   AtriumNetIntent.read with the project dictionary applied
//   suggest(project, {used?, F?}) -> [suggestion]   diff / bus / rail / ground (§8), declines removed;
//     recomputed per stem bucket whose names changed
//   complete(project, typed, {kind, limit}) -> [{name, why, score}]   names for a label, port or power port
//   accept / decline / setConvention ... (project, ...) -> message: one AtriumSignals.edit each
// Inferred intent is advice: DRC, the router and ECO read confirmed Signals only (signal.intent).
globalThis.AtriumNetIntentIndex = (() => {
  const G = globalThis, N = () => G.AtriumNetIntent, A = () => G.Atrium;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "intent.why.name": "by its name",
    "intent.why.names": "by their names",
    "intent.why.pin": "by pin {pin} on {ref}",
    "intent.why.port": "by its power port",
    "intent.why.dictionary": "by the project's naming dictionary",
    "intent.why.regulator": "from {parameter} on {ref}",
    "intent.why.divider": "estimated from the feedback divider on {ref} ({upper}, {lower}; {reference} V reference)",
    "intent.why.ab": "A taken as the non-inverting line; flip it if the transceiver says otherwise",
    "intent.why.ab_ask": "{a} calls {line} its A line and {b} its B line: check which is non-inverting before accepting",
    "intent.done.pair": "Differential signal {name} declared (+ {positive}, − {negative})",
    "intent.done.bus": "Bus {name} declared ({count} nets)",
    "intent.done.rail": "{net} confirmed as a rail",
    "intent.done.ground": "{net} confirmed as a ground",
    "intent.done.declined": "Suggestion {name} declined; it will not be suggested again",
    "intent.done.restored": "{count} declined suggestions will be suggested again",
    "intent.done.saved": "Naming conventions saved",
    "intent.done.imported": "Naming conventions imported: {count} changes",
    "intent.done.group_on": "Using naming conventions from {group}, revision {rev}",
    "intent.done.group_off": "Group naming conventions turned off",
    "intent.group.unavailable": "Approve naming conventions in the group library first.",
    "intent.done.tagged": "Tagged {count} nets {tag}",
    "intent.import.bad": "This is not a Waffle naming conventions file.",
    "intent.import.newer": "These naming conventions were saved by a newer Waffle.",
    "intent.create.two": "Choose two nets for a differential pair, or more nets named as pairs.",
    "intent.create.none": "None of the chosen nets pair by their names. Choose two nets to pair them anyway.",
    "intent.create.bus": "Choose two or more nets for a bus.",
    "intent.create.tag": "Name the tag.",
    "intent.create.nets": "Choose the nets first.",
    "intent.complete.used": "used {count}×",
    "intent.complete.partner": "partner of {name}",
    "intent.complete.next": "next in {from}–{to}",
    "intent.complete.gap": "missing from {from}–{to}",
    "intent.complete.rail": "project style for {volts} V rails",
    "intent.complete.low": "active low, project style",
    "intent.complete.case": "project spelling"
  });
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const fail = m => { throw Error(m); };
  const lower = s => String(s).toLowerCase(), upper = s => String(s).replace(/[a-z]/g, c => c.toUpperCase());
  // Natural order (D2 before D10), the same everywhere ("en" collation, then code units).
  const coll = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator("en", {numeric: true, sensitivity: "base"}) : null;
  const natural = (a, b) => (coll ? coll.compare(String(a), String(b)) : 0) || (a < b ? -1 : a > b ? 1 : 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const pk = p => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
  // FNV-1a, two lanes (the suggestion keys; stable across versions, as insights.js keyOf).
  function hash(s) {
    let a = 0x811c9dc5, b = 5381;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b, 33) ^ c; }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }
  const NAMED = new Set(["netlabel", "power", "port", "offsheet"]);
  // Objects whose change can change a sheet's nets, names or pins.
  const ELECTRICAL = new Set(["part", "wire", "netlabel", "power", "port", "offsheet", "junction", "busentry", "bus", "sheetsymbol", "noerc"]);

  // ------------------------------------------------------------------ facts per document
  const nameEntry = () => ({n: 0, power: 0, port: 0, label: 0, wire: 0, board: 0, items: []});
  const pinNames = new WeakMap();
  // Pin number -> pin name from a definition's schematic symbol (the board reads pin names there).
  function pinNameMap(def) {
    if (!def) return null;
    let m = pinNames.get(def);
    if (!m) { m = new Map(); for (const p of def.symbol?.pins || []) if (p?.number != null && !m.has(String(p.number))) m.set(String(p.number), String(p.name ?? "")); pinNames.set(def, m); }
    return m;
  }
  function sheetFacts(project, sheet, defs) {
    const S = G.AtriumSchObjects, conn = A().sheetNets?.(project, sheet, defs) || A().connectivity(sheet, defs);
    const pins = [], names = new Map(), twoPin = [], aliases = [];
    const addName = (name, kind, item, at) => {
      if (!name) return;
      let e = names.get(name); if (!e) names.set(name, e = nameEntry());
      e.n++; e[kind === "power" ? "power" : kind === "port" || kind === "offsheet" ? "port" : kind === "wire" ? "wire" : "label"]++;
      if (e.items.length < 64) e.items.push({id: item.id, kind, at: at ? [at[0], at[1]] : null, doc: sheet.id, item});
    };
    for (const i of sheet.items) {
      if (i.kind === "part") {
        const def = defs.get(i.def);
        if (S?.notElectrical?.(i, def)) continue;
        let list = [];
        try { list = A().pins(i, def, "schematic"); } catch { list = []; }
        const mine = [];
        for (const p of list) {
          if (p.hidden) continue;
          const e = {part: i, ref: String(i.ref || ""), number: String(p.number ?? ""), name: String(p.name ?? ""), electrical: p.electrical, at: p.at, net: conn.byPin.get(i.id + "/" + p.number) || null, doc: sheet.id};
          pins.push(e); mine.push(e);
        }
        if (mine.length === 2) twoPin.push({part: i, def, ref: String(i.ref || ""), nets: [mine[0].net, mine[1].net], pins: mine, doc: sheet.id});
      } else if (NAMED.has(i.kind) && typeof i.text === "string" && i.text.trim() && !S?.isBus?.(i.text)) addName(i.text.trim(), i.kind, i, [i.x, i.y]);
      else if (i.kind === "wire" && i.net) addName(i.net, "wire", i, i.points?.[0]);
    }
    // Two names on one net (only when connectivity saw a net with more than one): each name object is
    // placed on the net at its hot spot; a name whose net carries another name is an alias of it.
    if (conn.nets.some(n => n.conflict)) {
      const at = new Map(), wires = sheet.items.filter(i => i.kind === "wire" && i.points?.length > 1 && conn.byWire.has(i.id));
      for (const p of pins) if (p.net) at.set(pk(p.at), p.net);
      const netAt = q => {
        const k = at.get(pk(q)); if (k) return k;
        for (const w of wires) for (let j = 1; j < w.points.length; j++) if (A().nearSegment(q, w.points[j - 1], w.points[j]) < 1.1e-4) return conn.byWire.get(w.id);
        return null;
      };
      const seen = new Set();
      for (const [name, e] of names) for (const it of e.items) {
        if (it.kind === "wire" || !it.at) continue;
        const net = netAt(it.at);
        if (!net || net === name || seen.has(net + "\u0001" + name)) continue;
        seen.add(net + "\u0001" + name);
        aliases.push({net, name, item: it.item, at: it.at, doc: sheet.id});
      }
    }
    return {kind: "schematic", doc: sheet, names, pins, twoPin, aliases};
  }
  // A board, by object: each object's contribution (nets, pins with names, a two-pin part) is kept so an
  // edit patches only the objects it changed.
  function contribution(item, defs, doc) {
    if (item.kind === "part") {
      const def = defs.get(item.def), names = pinNameMap(def), pins = [], nets = new Set();
      for (const [num, net] of Object.entries(item.pinNets || {})) if (net) { nets.add(net); pins.push({part: item, ref: String(item.ref || ""), number: num, name: names?.get(num) ?? "", net, doc}); }
      return {nets: [...nets], pins, two: pins.length === 2 ? {part: item, def, ref: String(item.ref || ""), nets: [pins[0].net, pins[1].net], pins, doc} : null};
    }
    return item.net ? {nets: [item.net], pins: [], two: null} : null;
  }
  function boardApply(f, id, c, sign) {
    if (!c) return;
    for (const n of c.nets) {
      let e = f.names.get(n);
      if (sign > 0) { if (!e) f.names.set(n, e = nameEntry()); e.n++; e.board++; }
      else if (e && --e.n <= 0) f.names.delete(n); else if (e) e.board--;
    }
    for (const p of c.pins) {
      let s = f.pins.get(p.net);
      if (sign > 0) { if (!s) f.pins.set(p.net, s = new Set()); s.add(p); } else if (s) { s.delete(p); if (!s.size) f.pins.delete(p.net); }
    }
    if (c.two) { if (sign > 0) f.two.set(id, c.two); else f.two.delete(id); }
  }
  function boardFacts(board, defs) {
    const f = {kind: "pcb", doc: board, names: new Map(), pins: new Map(), two: new Map(), by: new Map(), defs};
    for (const i of board.items) { const c = contribution(i, defs, board.id); if (c) { f.by.set(i.id, c); boardApply(f, i.id, c, 1); } }
    return f;
  }
  function boardPatch(f, ids, items) {
    for (const id of ids) {
      boardApply(f, id, f.by.get(id), -1); f.by.delete(id);
      const live = items.get(id), c = live && contribution(live, f.defs, f.doc.id);
      if (c) { f.by.set(id, c); boardApply(f, id, c, 1); }
    }
  }
  // Per-document memo. With the undo store, the journal says what changed since the last read; without
  // it (MCP, tests) every read is fresh unless the caller passes a generation.
  const docMemo = new WeakMap();
  let stats = {sheets: 0, boards: 0, patched: 0, reused: 0, buckets: 0};
  function docFacts(doc, defs, project) {
    const U = G.AtriumUndoStore, e = docMemo.get(doc), lib = project?.library;
    const fresh = () => { const f = doc.kind === "pcb" ? (stats.boards++, boardFacts(doc, defs)) : (stats.sheets++, sheetFacts(project, doc, defs)); f.gen = (e?.f.gen || 0) + 1; return f; };
    let f = null, v = null, ch = null;
    if (U?.changed && U.documentVersions) {
      try { ch = e?.seq != null ? U.changed(doc, e.seq) : null; } catch { ch = null; }
      try { v = U.documentVersions(doc, project); } catch { v = null; }
      if (v && e && e.lib === lib && e.libLen === lib?.length && e.libv === v.library && ch?.ids) {
        if (doc.kind === "pcb") { if (ch.ids.size) { e.f.defs = defs; boardPatch(e.f, ch.ids, ch.items); e.f.gen++; stats.patched++; } else stats.reused++; f = e.f; }
        else {
          let electrical = false;
          for (const id of ch.ids) { const live = ch.items.get(id); if (!live || ELECTRICAL.has(live.kind) || e.kinds.has(id)) { electrical = true; break; } }
          f = electrical ? fresh() : (stats.reused++, e.f);
        }
      }
    }
    f ||= fresh();
    if (!v) { docMemo.delete(doc); return f; }
    // Schematic objects whose removal changes the facts (the journal gives no kind for a removed object).
    const kinds = doc.kind === "pcb" ? null : e?.f === f ? e.kinds : new Set(doc.items.filter(i => ELECTRICAL.has(i.kind)).map(i => i.id));
    docMemo.set(doc, {f, seq: v.seq, lib, libLen: lib?.length, libv: v.library, kinds});
    return f;
  }
  // Definitions by id, memoised on the library list.
  const defsMemo = new WeakMap();
  const defsOf = project => { const lib = project?.library; if (!Array.isArray(lib)) return new Map(); let d = defsMemo.get(lib); if (!d || d.n !== lib.length) defsMemo.set(lib, d = {n: lib.length, map: new Map(lib.map(x => [x.id, x]))}); return d.map; };
  const merged = new WeakMap();
  // The project's facts: every sheet's names and pins joined by name (the default global net scope), and
  // every board's nets. Memoised on the documents' facts (identity and generation).
  function facts(project, defs) {
    defs ||= defsOf(project);
    const docs = (project?.documents || []).filter(d => d && (d.kind === "schematic" || d.kind === "pcb") && Array.isArray(d.items));
    const per = docs.map(d => docFacts(d, defs, project)), stamp = per.map(f => f.doc.id + ":" + f.gen).join("|");
    const old = project && merged.get(project);
    if (old && old.stamp === stamp && old.per.every((f, i) => f === per[i])) return old.F;
    const names = new Map(), pins = new Map(), boardPins = new Map(), twoPin = [], boardTwo = [], aliases = [];
    for (const f of per) {
      for (const [n, e] of f.names) {
        let x = names.get(n); if (!x) names.set(n, x = nameEntry());
        for (const k of ["n", "power", "port", "label", "wire", "board"]) x[k] += e[k];
        if (x.items.length < 64) x.items.push(...e.items.slice(0, 64 - x.items.length));
      }
      if (f.kind === "pcb") {
        for (const [n, s] of f.pins) { const a = boardPins.get(n); if (!a) boardPins.set(n, s); else boardPins.set(n, [...a, ...s]); }
        boardTwo.push(...f.two.values());
      } else {
        for (const p of f.pins) if (p.net) { let a = pins.get(p.net); if (!a) pins.set(p.net, a = []); a.push(p); }
        twoPin.push(...f.twoPin); aliases.push(...f.aliases);
      }
    }
    const F = {names, pins, boardPins, twoPin, boardTwo, aliases, defs, gen: (old?.F.gen || 0) + 1, hasSchematic: docs.some(d => d.kind === "schematic")};
    if (project) merged.set(project, {stamp, per, F});
    return F;
  }

  // ------------------------------------------------------------------ conventions (§6)
  const MIN = 5, AGREE = .9;
  function storedConventions(project, c = project?.signals?.conventions) {
    const ok = plain(c) ? c : {};
    const list = v => Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).map(x => x.trim()) : [];
    const map = (v, keys) => { const o = {}; for (const k of keys) o[k] = list(plain(v) ? v[k] : null); return o; };
    return {keep: plain(ok.keep) ? ok.keep : {}, forget: list(ok.forget), stems: map(ok.stems, ["rail", "ground", "clock"]), never: map(ok.never, ["pair", "bus", "rail", "kinds"]),
      loneN: ok.loneN === "pair" ? "pair" : "activeLow", rs485: ok.rs485 === "B" ? "B" : "A", tally: plain(ok.tally) ? ok.tally : {}, raw: ok};
  }
  // Rail spelling: sign (+, P or none), decimal mark (3V3 or 3.3V), a trailing 0 on whole volts (5V0), a
  // stem before the voltage (VCC_3V3).
  function railStyleOf(name) {
    const m = /^(?:([A-Z]+[A-Z0-9]*?)([_\-.]))?(\+|PP|P)?(\d+)(?:V(\d+)|([.,]\d+)?V)$/i.exec(name);
    if (!m) return null;
    return {stem: m[1] ? upper(m[1]) + m[2] : "", sign: m[3] ? upper(m[3]) : "", mark: m[5] != null ? "V" : m[6] ? "." : null, zero: m[5] === "0"};
  }
  function renderRail(v, s) {
    if (!Number.isFinite(v)) return "";
    const neg = v < 0, a = Math.abs(v), whole = Number.isInteger(a), dot = String(Math.round(a * 1000) / 1000);
    const body = s.mark === "." ? dot + "V" : whole ? a + (s.zero ? "V0" : "V") : dot.replace(".", "V");
    return s.stem + (neg ? s.sign === "P" || s.sign === "PP" ? "N" : "-" : s.sign) + body;
  }
  const railId = s => renderRail(3.3, s) + " · " + renderRail(5, s);
  /** @type {[string, RegExp][]} */
  const LOW_STYLES = [["\\", /^\\(?!\\)/], ["~{}", /^~\{/],["/", /^\//], ["!", /^!/], ["#", /#$/], ["n", /^n[A-Z]/], ["_N", /[_\-]N$/], ["n suffix", /[A-Z]n$/], ["_B", /[_\-]B$/], ["_L", /[_\-]L$/], ["X", /^X[A-Z]/]];
  const lowStyleOf = name => LOW_STYLES.find(([, re]) => re.test(name))?.[0] || null;
  function renderLow(stem, style) {
    const s = upper(stem);
    return {"\\": "\\" + s, "~{}": "~{" + s + "}","/": "/" + s, "!": "!" + s, "#": s + "#", n: "n" + s, _N: s + "_N", "n suffix": s + "n", _B: s + "_B", _L: s + "_L", X: "X" + s}[style] || "n" + s;
  }
  const busStyleOf = name => { const m = /[A-Za-z]([_\-.]?)(\[?)\d+\]?$/.exec(name); return m ? (m[2] ? "[n]" : m[1] || "n") : null; };
  // One learned convention: the most used value, applied when it has MIN uses and AGREE agreement, or kept.
  function card(id, counts, examples, stored, describe) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    let best = null, n = 0;
    for (const [v, c] of [...counts].sort((a, b) => b[1] - a[1] || natural(a[0], b[0]))) if (c > n) { best = v; n = c; }
    const kept = stored.keep[id], forgotten = stored.forget.includes(id);
    const value = kept != null ? (typeof kept === "string" ? kept : kept.id) : best;
    const status = kept != null ? "kept" : forgotten ? "forgotten" : best != null && n >= MIN && n / total >= AGREE ? "learned" : best != null ? "seen" : "none";
    return {id, value, n, total, agree: total ? n / total : 0, status, applied: status === "kept" || status === "learned",
      examples: (examples.get(value) || []).slice(0, 6), others: [...counts].filter(([v]) => v !== value).map(([v, c]) => ({value: v, n: c, examples: (examples.get(v) || []).slice(0, 3)})),
      describe: describe?.(value) ?? value};
  }
  const convMemo = new WeakMap();
  function conventions(project, F) {
    F ||= facts(project);
    const raw = project?.signals?.conventions, sigs = project?.signals?.signals || null;
    const old = project && convMemo.get(project);
    if (old && old.F === F && old.raw === raw && old.sigs === sigs) return old.out;
    const stored = storedConventions(project), group = selectedGroup(raw), grouped = withGroup(stored, group);
    /** @returns {[Map<any, number>, Map<any, string[]>]} counts and examples by value */
    const tally = () => [new Map(), new Map()], NI = N();
    const bump = ([c, ex], v, name) => { c.set(v, (c.get(v) || 0) + 1); let a = ex.get(v); if (!a) ex.set(v, a = []); if (a.length < 6) a.push(name); };
    const rail = tally(), low = tally(), pair = tally(), bus = tally(), cs = tally(), loneN = tally();
    const railStyles = new Map(), railNames = [];
    const names = [...F.names.keys()], stems = new Map(); // document order: deterministic for one file
    for (const n of names) {
      const r = NI.read(n);
      if (r.role === "auto" || r.role === "nc") continue;
      if (r.role === "rail" && Number.isFinite(r.voltage)) { const s = railStyleOf(n); if (s) railNames.push([n, s]); }
      if (r.activeLow) { const s = lowStyleOf(n); if (s) bump(low, s, n); }
      if (r.role === "control" && r.alt) bump(loneN, "activeLow", n);
      if (Number.isFinite(r.index) && r.stem && !/^(?:rail|ground|pairMember)$/.test(r.role)) { const k = r.stem; stems.set(k, (stems.get(k) || 0) + 1); }
      if (/[A-Z]/.test(n) && n.length > 1 && !r.activeLow && !/_[tc]$/.test(n)) bump(cs, /[a-z]/.test(n.replace(/^n(?=[A-Z])/, "")) ? "mixed" : "upper", n);
    }
    // Rails: the majority sign, stem and decimal mark make the style; whole volts (5V, 12V0) say only
    // whether a trailing 0 is written. Each name counts for the style it fits, else for its own.
    if (railNames.length) {
      const vote = f => { const c = new Map(); for (const [, x] of railNames) { const v = f(x); if (v != null) c.set(v, (c.get(v) || 0) + 1); } return [...c].sort((a, b) => b[1] - a[1] || natural(String(a[0]), String(b[0])))[0]?.[0]; };
      const major = {stem: vote(x => x.stem) ?? "", sign: vote(x => x.sign) ?? "", mark: vote(x => x.mark) ?? "V", zero: false};
      const z = railNames.filter(([, x]) => x.mark !== ".").map(([n, x]) => x.zero ? 1 : x.mark == null ? -1 : 0);
      major.zero = z.filter(v => v > 0).length > z.filter(v => v < 0).length;
      const fits = (x, m) => x.stem === m.stem && x.sign === m.sign && (x.mark == null || x.mark === m.mark) && (x.mark !== "V" || !x.zero || m.zero) && (x.mark != null || m.mark !== "V" || !m.zero);
      for (const [n, x] of railNames) {
        const st = fits(x, major) ? major : {...x, mark: x.mark ?? (major.mark === "." ? "." : "V"), zero: !!x.zero}, id = railId(st);
        railStyles.set(id, st); bump(rail, id, n);
      }
    }
    for (const n of names) { const r = NI.read(n); if (Number.isFinite(r.index) && stems.get(r.stem) >= 2 && !/^(?:rail|ground|pairMember)$/.test(r.role)) { const s = busStyleOf(n); if (s) bump(bus, s, n); } }
    for (const p of NI.pairs(names, [], {min: "weak"})) { bump(pair, p.pattern, p.name); if (p.pattern === "P/N" && /_N$/i.test(p.negative)) bump(loneN, "pair", p.negative); }
    for (const s of sigs || []) if (s?.kind === "diff" && s.legs?.length === 2) { const o = NI.orient([s.legs[0].nets?.[0], s.legs[1].nets?.[0]]); if (o) bump(pair, o.pattern, s.name); }
    const cards = rules => [
      card("rail", rail[0], rail[1], rules, v => v),
      card("activeLow", low[0], low[1], rules, v => v ? renderLow("RST", v) + ", " + renderLow("CS", v) : null),
      card("pair", pair[0], pair[1], rules, v => v),
      card("bus", bus[0], bus[1], rules, v => v ? {n: "D0, D1", _: "D_0, D_1", "-": "D-0, D-1", ".": "D.0, D.1", "[n]": "D[0], D[1]"}[v] : null),
      card("case", cs[0], cs[1], rules, v => v === "upper" ? "USB_DP" : v === "mixed" ? "Usb_Dp" : null)
    ];
    const localCards = cards(stored), learned = group ? cards(grouped) : localCards;
    if (group) for (const c of learned) if (grouped.keep[c.id] != null && stored.keep[c.id] == null) c.status = "group";
    const lone = card("loneN", loneN[0], loneN[1], {keep: {}, forget: [], ...stored}, v => v);
    const keptRail = plain(grouped.keep.rail) ? grouped.keep.rail : null;
    if (keptRail) railStyles.set(railId(keptRail), keptRail);
    const pick = id => { const c = learned.find(x => x.id === id); return c.applied ? c.value : null; };
    // Spelling for completion: also a unanimous style seen fewer than MIN times (one 3V3 port is enough to
    // write 1V8, not +1.8V); a forgotten one is not used.
    const style = id => { const c = learned.find(x => x.id === id); return c.applied || c.status === "seen" && c.agree >= AGREE ? c.value : null; };
    const effective = {
      rail: keptRail || (style("rail") ? railStyles.get(style("rail")) : null),
      activeLow: style("activeLow"), pairs: pick("pair") ? [pick("pair")] : [], bus: pick("bus"), upper: pick("case") === "upper",
      loneN: grouped.raw.loneN ? grouped.loneN : lone.status === "learned" ? lone.value : "activeLow",
      rs485: grouped.rs485, stems: grouped.stems, never: grouped.never, tally: stored.tally
    };
    const out = {stored, learned, localCards, loneN: lone, effective, railStyles, group};
    if (project) convMemo.set(project, {F, raw, sigs, out});
    return out;
  }
  const EMPTY = Object.freeze({rail: null, activeLow: null, pairs: [], bus: null, upper: false, loneN: "activeLow", rs485: "A",
    stems: {rail: [], ground: [], clock: []}, never: {pair: [], bus: [], rail: [], kinds: []}, tally: {}});
  // A stem the dictionary names: the whole name, or its first token (VPROG, VPROG_A, VPROG_EN).
  const stemHit = (core, list) => { const u = upper(core); return list.find(s => { const x = upper(s); return u === x || u.startsWith(x) && /^[_\-.\d]/.test(u.slice(x.length)); }) || null; };
  const FUNCS = /[_\-.](?:EN|ENABLE|PG|PGOOD|POK|FB|SENSE|SNS|DET|OK|FAULT|FLT|ALERT|SHDN|MON|ADC)$/i;
  /** @param {string} name @param {any} [conv] the effective conventions (conventions().effective) */
  function classify(name, conv = EMPTY) {
    const r = N().read(name);
    if (r.role === "auto" || r.role === "nc" || !r.core) return r;
    let hit;
    if ((r.role === "rail" || r.role === "railSignal") && (hit = stemHit(r.core, conv.never.rail))) return {...r, role: "signal", level: "likely", by: "dictionary", stem: hit};
    if (r.role !== "rail" && r.role !== "ground" && (hit = stemHit(r.core, conv.stems.rail)))
      return FUNCS.test(r.core) ? {...r, role: "railSignal", level: "likely", rail: hit, by: "dictionary"} : {...r, role: "rail", level: "likely", voltage: r.voltage ?? null, kind: "supply", by: "dictionary"};
    if (r.role !== "ground" && (hit = stemHit(r.core, conv.stems.ground))) return {...r, role: "ground", level: "likely", domain: upper(r.core.slice(hit.length).replace(/^[_\-.]/, "")) || upper(hit), isolated: /ISO/i.test(r.core), by: "dictionary"};
    if (!r.clock && (hit = stemHit(r.core, conv.stems.clock))) return {...r, role: "clock", clock: true, level: "likely", highSpeed: true, by: "dictionary"};
    if (r.alt && conv.loneN === "pair") return {...r, ...r.alt, role: "pairMember", activeLow: false, by: "convention"};
    return r;
  }

  // ------------------------------------------------------------------ regulator voltage evidence
  const REGULATOR = /\b(?:regulators?|ldo|(?:buck(?:-boost)?|boost|step[- ](?:up|down)|dc[ /-]*dc) (?:converters?|modules?))\b/i;
  const REGULATOR_TYPE = /^(?:buck(?:[ -]boost)?|boost|step[- ](?:up|down)|dc[ /-]*dc)$/i;
  const SWITCHING = /\b(?:switching|buck|boost|step[- ](?:up|down)|dc[ /-]*dc)\b/i;
  const VOLTAGE_OUT = /^(?:vout|outputvoltage|nominaloutputvoltage|regulatedoutputvoltage)(?:v|mv|uv|kv)?$/;
  const VOLTAGE_REF = /^(?:vfb|vref|referencevoltage|feedbackvoltage|feedbackreference(?:voltage)?)(?:v|mv|uv|kv)?$/;
  const GROUND_PIN = /^(?:[ADPS]?GND|GROUND|VSS)\d*$/;
  const FEEDBACK_PIN = /^(?:FB|VFB|FEEDBACK)$/;
  const OUT_PIN = /^(?:VOUT|OUT|OUTPUT)\d*$/;
  const paramKey = s => lower(s).replace(/[^a-z0-9]/g, "");
  const pinName = p => upper(p.name.trim()).replace(/[ _]/g, "");
  function parameter(part, def, keys) {
    for (const params of [part.parameters, def?.parameters]) {
      for (const [key, value] of Object.entries(params || {})) if (keys.test(paramKey(key))) return {key, value};
    }
    return null;
  }
  function dcParameter(part, def, keys) {
    const p = parameter(part, def, keys);
    if (!p || typeof p.value !== "string" && typeof p.value !== "number") return null;
    const raw = String(p.value).trim().replace(/−/g, "-").replace(/^([+-]?\d+)[vV](\d+)$/, "$1.$2 V");
    const m = /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*([mµμuMkK]?[vV](?:\s*[dD][cC])?)?$/.exec(raw);
    if (!m) return null;
    const unit = (m[2] || /(?:^|\s|\()\s*([mµμuMkK]?[vV])\s*\)?$/.exec(p.key)?.[1] || "V").replace(/\s*[dD][cC]$/, "");
    const scale = unit.length === 2 ? {m: 1e-3, u: 1e-6, "µ": 1e-6, "μ": 1e-6, k: 1e3, K: 1e3, M: 1e6}[unit[0]] : 1;
    const voltage = +m[1].replace(",", ".") * scale;
    return voltage && Number.isFinite(voltage) && Math.abs(voltage) <= 1e4 ? {key: p.key, voltage: Number(voltage.toPrecision(8))} : null;
  }
  function resistance(entry) {
    const {part, def, ref} = entry;
    const family = [def?.name, def?.category, def?.generic?.family].join(" ");
    if (!(/^R\d/i.test(ref) || /\bresistors?\b/i.test(family)) ||
        /potentiometer|trimmer|thermistor|varistor|photoresistor|resistor (?:array|network)/i.test(family)) return null;
    const value = parameter(part, def, /^(?:resistance|resistanceohms?)$/)?.value ?? (part.value || def?.value);
    const s = String(value ?? "").normalize("NFKC").trim().replace(/\s+\d+(?:[.,]\d+)?\s*%$/, "")
      .replace(/\s*(?:Ω|ohms?)$/i, "").replace(",", ".").replace(/\s+/g, "");
    const scale = {m: 1e-3, k: 1e3, K: 1e3, M: 1e6, R: 1, r: 1, "": 1};
    const rkm = /^(\d*)([RrkKMm])(\d+)$/.exec(s), decimal = /^(\d+(?:\.\d+)?|\.\d+)([RrkKMm]?)$/.exec(s);
    const v = rkm ? +(rkm[1] + "." + rkm[3]) * scale[rkm[2]] : decimal ? +decimal[1] * scale[decimal[2]] : 0;
    return v > 0 && Number.isFinite(v) ? {v, text: v >= 1e6 ? v / 1e6 + " MΩ" : v >= 1e3 ? v / 1e3 + " kΩ" : v + " Ω"} : null;
  }
  const closeVoltage = (a, b) => Math.abs(a - b) <= Math.max(.05, .03 * Math.max(Math.abs(a), Math.abs(b)));
  const regulatorMatchesName = (reading, evidence) => reading.role !== "ground" && reading.role !== "mains" &&
    (!Number.isFinite(reading.voltage) || closeVoltage(reading.voltage, evidence.voltage));
  const fitted = p => p.fitted !== false && p.dnp !== true;
  function findRegulators(F, conv, pinMap, twoPin, doc = null, collectDivider = null) {
    const parts = new Map(), pairs = new Map(), result = new Map();
    for (const entries of pinMap.values()) for (const p of entries) {
      if (!fitted(p.part) || doc != null && p.doc !== doc) continue;
      let pins = parts.get(p.part);
      if (!pins) parts.set(p.part, pins = []);
      pins.push(p);
    }
    for (const entry of twoPin) if (fitted(entry.part) && (doc == null || entry.doc === doc)) pairs.set(entry.part, entry);
    const read = n => classify(n, conv);
    for (const [part, pins] of parts) {
      const def = F.defs.get(part.def), type = parameter(part, def, /^(?:type|parttype|componenttype)$/)?.value;
      const types = [type, part.type, part.partType, def?.type, def?.partType, def?.category].filter(x => typeof x === "string");
      const detail = parameter(part, def, /^description$/)?.value;
      const desc = [...types, detail, part.description, def?.description, def?.name].filter(x => typeof x === "string").join(" ").replace(/_/g, " ");
      if (!REGULATOR.test(desc) && !types.some(x => REGULATOR_TYPE.test(x.trim()))) continue;
      const outputs = pins.filter(p => OUT_PIN.test(pinName(p))), output = outputs[0];
      if (!output || outputs.some(p => p.net !== output.net)) continue;
      const grounds = [...new Set(pins.filter(p => GROUND_PIN.test(pinName(p))).map(p => p.net))];
      if (grounds.length > 1 || grounds.includes(output.net)) continue;
      const returnNet = grounds[0], ground = returnNet && read(returnNet), named = read(output.net);
      if (returnNet && ground.role !== "ground" && !collectDivider) continue;
      const domain = ground?.domain || (/ISO/i.test(named.variant || "") ? "ISO" : ""), isolated = !!ground?.isolated || /ISO/i.test(domain);
      const fbPins = pins.filter(p => FEEDBACK_PIN.test(pinName(p))), fb = fbPins[0]?.net;
      const reference = dcParameter(part, def, VOLTAGE_REF);
      let divider = null;
      if (returnNet && (collectDivider || reference && ground?.role === "ground" && ground.level !== "weak") &&
          fbPins.length === 1 && fb !== output.net && fb !== returnNet && pins.filter(p => p.net === fb).length === 1) {
        const legs = [];
        for (const pin of pinMap.get(fb) || []) {
          if (pin.part === part || !fitted(pin.part) || doc != null && pin.doc !== doc) continue;
          const entry = pairs.get(pin.part), other = entry?.nets.find(n => n && n !== fb), ohms = entry && resistance(entry);
          legs.push(ohms && {pin, other, ...ohms});
        }
        const top = legs.find(x => x?.other === output.net), bottom = legs.find(x => x?.other === returnNet);
        if (legs.length === 2 && top && bottom && top.pin.part !== bottom.pin.part) {
          collectDivider?.({regulator: part, net: fb, top, bottom, vref: reference?.voltage ?? null});
          const v = reference ? reference.voltage * (1 + top.v / bottom.v) : NaN;
          if (Number.isFinite(v) && Math.abs(v) <= 1e4) divider = {voltage: Number(v.toPrecision(6)), level: "likely",
            basis: t("intent.why.divider", {ref: output.ref, upper: top.pin.ref + " " + top.text, lower: bottom.pin.ref + " " + bottom.text, reference: String(reference.voltage)})};
        }
      }
      const explicit = SWITCHING.test(desc) && !pinName(output).startsWith("VOUT") ? null : dcParameter(part, def, VOLTAGE_OUT);
      if (!explicit && !divider) continue;
      const e = explicit ? {voltage: explicit.voltage, level: "strong", basis: t("intent.why.regulator", {ref: output.ref, parameter: explicit.key})} : divider;
      const previous = result.get(output.net);
      if (explicit && divider && !closeVoltage(explicit.voltage, divider.voltage) || previous === null ||
          previous && (!closeVoltage(previous.voltage, e.voltage) || previous.returnNet !== returnNet)) result.set(output.net, null);
      else if (!previous || previous.level === "likely" && e.level === "strong") result.set(output.net, {...e, pin: output, returnNet, domain, isolated});
    }
    return result;
  }
  // One local electrical projection, shared with the regulator voltage analysis. Keep
  // sheet-local anonymous nets and identical-looking names on other boards separate.
  const terminalMemo = new WeakMap();
  function localTerminals(project, doc, defs) {
    const f = docFacts(doc, defs, project), previous = terminalMemo.get(f);
    if (previous?.gen === f.gen) return previous;
    const two = doc.kind === "pcb" ? [...f.two.values()] : f.twoPin, pins = new Map();
    if (doc.kind === "pcb") for (const [net, list] of f.pins) pins.set(net, list);
    else for (const pin of f.pins) if (pin.net) {
      if (!pins.has(pin.net)) pins.set(pin.net, []);
      pins.get(pin.net).push(pin);
    }
    const dividers = [];
    findRegulators({defs}, EMPTY, pins, two, doc.id, d => dividers.push(d));
    const result = {gen: f.gen, dividers, two, pins, names: f.names};
    terminalMemo.set(f, result);
    return result;
  }
  const regMemo = new WeakMap();
  function regulatorVoltages(F, conv, board) {
    let state = regMemo.get(F);
    if (!state || state.conv !== conv) {
      state = {conv, schematic: findRegulators(F, conv, F.pins, F.twoPin), boards: new Map()};
      regMemo.set(F, state);
    }
    if (!board) return state.schematic;
    if (!state.boards.has(board.id)) {
      const local = findRegulators(F, conv, F.boardPins, F.boardTwo, board.id);
      state.boards.set(board.id, new Map([...local, ...state.schematic]));
    }
    return state.boards.get(board.id);
  }

  // ------------------------------------------------------------------ suggestions (§5, §8)
  const pairMember = (r, conv) => r.role === "pairMember" ? r : conv.loneN === "pair" && r.alt ? r.alt : null;
  // The bucket a name's suggestions depend on: its pair stem, its bus stem, or the name itself (rails).
  function bucketOf(name, conv) {
    const r = classify(name, conv);
    if (r.role === "auto" || r.role === "nc") return null;
    const p = pairMember(r, conv) || N().read(name).alt;
    if (p) return "p:" + upper(p.stem);
    if (r.role === "rail" || r.role === "ground") return "r:" + name;
    if (Number.isFinite(r.index) && r.stem) return "b:" + upper(r.stem);
    return null;
  }
  // The pin evidence for a net: [{ref, pin, reading}] from schematic pins, else board pins.
  const pinsOn = (F, net) => F.pins.get(net) || F.boardPins.get(net) || [];
  function pinPolarity(F, net) {
    const out = [];
    for (const p of pinsOn(F, net)) { const pol = p.name && N().polarity(p.name); if (pol) out.push({ref: p.ref, pin: p.name, polarity: pol.polarity}); }
    return out;
  }
  function bucketSuggestions(key, names, F, conv) {
    const NI = N(), out = [];
    if (key.startsWith("p:")) {
      for (const p of NI.pairs(names, [], {min: "weak"})) {
        let positive = p.positive, negative = p.negative;
        if (p.pattern === "A/B" && conv.rs485 === "B") [positive, negative] = [negative, positive];
        const ev = pinPolarity(F, positive).filter(x => x.polarity === 1), basis = ev.length ? t("intent.why.pin", {pin: ev[0].pin, ref: ev[0].ref}) : t("intent.why.names");
        const r = NI.read(positive);
        // A/B: the project's choice says which line is +; only when the parts on the line disagree (one calls
        // it A, another B) is the suggestion a question.
        let ask = null;
        if (p.pattern === "A/B") {
          const named = upper(p.positive).slice(-1), pins = [...pinsOn(F, p.positive)].filter(x => /^[AB]$/i.test(x.name || "")), other = pins.find(x => upper(x.name) !== named);
          if (other) ask = t("intent.why.ab_ask", {a: pins.find(x => upper(x.name) === named)?.ref || p.positive, b: other.ref, line: p.positive});
        }
        out.push({key: "diff:" + hash([positive, negative].sort().join("\u0001")), kind: "diff", name: p.name, positive, negative, members: [{net: positive, polarity: 1}, {net: negative, polarity: -1}],
          pattern: p.pattern, level: ask ? "weak" : ev.length ? "strong" : p.level || "likely", basis, intent: {role: "pairMember", pattern: p.pattern, ...(r.protocol ? {protocol: r.protocol} : {})}, ...(ask ? {ask} : {}),
          why: [basis, ...(p.explain || []).slice(0, 2), ...(ask ? [ask] : p.pattern === "A/B" ? [t("intent.why.ab")] : [])].join("; ")});
      }
    } else if (key.startsWith("b:")) {
      const members = names.map(n => ({n, r: classify(n, conv)})).filter(x => Number.isFinite(x.r.index) && x.r.role !== "rail" && x.r.role !== "ground").sort((a, b) => a.r.index - b.r.index);
      const idx = new Set(members.map(m => m.r.index));
      if (members.length >= 3 && idx.size === members.length) {
        const stem = members[0].r.stem, base = stem.replace(/[_\-.[\]]+$/, "") || stem, lo = members[0].r.index, hi = members.at(-1).r.index;
        out.push({key: "bus:" + hash(upper(stem) + "\u0001" + members.map(m => m.n).join("\u0001")), kind: "bus", name: base, stem: upper(base), range: [lo, hi], members: members.map(m => ({net: m.n, index: m.r.index})),
          level: "likely", basis: t("intent.why.names"), intent: {role: "bus", stem: base}, why: t("intent.why.names") + "; " + members.length + " members, " + lo + "–" + hi});
      }
    } else {
      const net = names[0], r = classify(net, conv), e = F.names.get(net);
      if (r.role === "rail" || r.role === "ground") {
        const basis = e?.power ? t("intent.why.port") : r.by === "dictionary" ? t("intent.why.dictionary") : t("intent.why.name"), v = Number.isFinite(r.voltage) ? r.voltage : Number.isFinite(r.nominal) ? r.nominal : null;
        const intent = r.role === "rail" ? {role: "rail", ...(v != null ? {voltage: v} : {}), ...(r.kind && r.kind !== "supply" ? {kind: r.kind} : {})} : {role: "ground", ...(r.domain ? {domain: r.domain} : {}), ...(r.isolated ? {isolated: true} : {})};
        out.push({key: r.role + ":" + hash(net), kind: r.role, name: net, net, members: [{net}], level: e?.power ? "strong" : "likely", basis, intent, tags: [r.role === "rail" ? "Power" : "GND"],
          why: basis + (v != null ? "; " + v + " V" : r.domain ? "; domain " + r.domain : "")});
      }
    }
    return out;
  }
  const sugMemo = new WeakMap();
  // Suggestions for the project's nets that no signal holds yet. o.used: nets already in a signal (the
  // Signals model's spans); else the stored signals' seed nets. Buckets are recomputed only when their
  // names changed since the last call.
  function suggest(project, o = {}) {
    const F = o.F || facts(project, o.defs), C = conventions(project, F), conv = C.effective, raw = project?.signals?.conventions;
    let m = project && sugMemo.get(project);
    if (!m || m.raw !== raw || m.loneN !== conv.loneN) m = {raw, loneN: conv.loneN, buckets: new Map(), F: null, recomputed: 0};
    if (m.F !== F) {
      const now = new Map();
      for (const n of F.names.keys()) { const k = bucketOf(n, conv); if (k) { let a = now.get(k); if (!a) now.set(k, a = []); a.push(n); } }
      const next = new Map();
      m.recomputed = 0;
      for (const [k, list] of now) {
        list.sort(natural);
        const sig = list.join("\u0001"), old = m.buckets.get(k);
        next.set(k, old && old.sig === sig ? old : (m.recomputed++, {sig, out: bucketSuggestions(k, list, F, conv)}));
      }
      m.buckets = next; m.F = F; stats.buckets += m.recomputed;
      if (project) sugMemo.set(project, m);
    }
    const declined = plain(project?.signals?.declined) ? project.signals.declined : {}, used = o.used || storedNets(project), hidden = dismissedHints(project);
    const never = conv.never, out = [];
    for (const {out: list} of m.buckets.values()) for (const g of list) {
      if (declined[g.key] || hidden.has(g.key) || never.kinds.includes(g.kind) || g.members.some(x => used.has(x.net))) continue;
      if (g.kind === "diff" && never.pair.includes(g.pattern) || g.kind === "bus" && never.bus.some(s => upper(s) === g.stem)) continue;
      out.push(g);
    }
    const order = {diff: 0, bus: 1, rail: 2, ground: 3};
    return out.sort((a, b) => order[a.kind] - order[b.kind] || natural(a.name, b.name));
  }
  // A dismissed suggestion hint (insights-intent.js nameSuggestion; its sig is the suggestion key) is a decline.
  function dismissedHints(project) {
    const d = project?.insights?.dismissed, out = new Set();
    if (plain(d)) for (const r of Object.values(d)) if (r?.check === "nameSuggestion" && typeof r.sig === "string") out.add(r.sig);
    return out;
  }
  function storedNets(project) {
    const out = new Set(), S = G.AtriumSignals;
    let st = null;
    try { st = S ? S.effective?.(project) || (project?.signals ? null : S.fromLegacy?.(project)) : project?.signals; } catch { st = project?.signals || null; }
    for (const s of st?.signals || []) for (const l of s.legs || []) for (const n of l.nets || []) out.add(n);
    return out;
  }
  // "Stop suggesting …" offers: a pattern (or bus stem) declined three times and never accepted.
  function offers(project) {
    const T = storedConventions(project).tally, out = [];
    for (const [k, v] of Object.entries(T)) if (Array.isArray(v) && (v[1] | 0) >= 3 && !(v[0] | 0)) { const [kind, ...rest] = k.split(":"); out.push({key: k, kind, value: rest.join(":"), declined: v[1] | 0}); }
    return out.filter(x => { const nv = storedConventions(project).never; return x.kind === "diff" ? !nv.pair.includes(x.value) : x.kind === "bus" ? !nv.bus.includes(x.value) : !nv.kinds.includes(x.kind); });
  }

  // ------------------------------------------------------------------ store edits (one AtriumSignals.edit each)
  const S = () => G.AtriumSignals || fail("Signals are not loaded.");
  const uid = () => G.Atrium.id();
  function uniqueName(st, base) { const used = new Set(st.signals.map(s => lower(s.name))); let n = base || "SIG", i = 2; while (used.has(lower(n))) n = base + "_" + i++; return n; }
  const tallyKey = g => g.kind + ":" + (g.kind === "diff" ? g.pattern : g.kind === "bus" ? g.stem : "");
  function count(st, g, slot) {
    const c = st.conventions = {...(plain(st.conventions) ? st.conventions : {})}, T = c.tally = {...(plain(c.tally) ? c.tally : {})}, k = tallyKey(g);
    const v = Array.isArray(T[k]) ? [T[k][0] | 0, T[k][1] | 0] : [0, 0]; v[slot]++; T[k] = v;
  }
  function acceptInto(st, g) {
    const date = today(), intent = {...g.intent, source: g.intent?.source || "name", confirmed: date};
    st.signals ||= []; st.tags ||= [];
    const addTag = name => { if (!st.tags.some(x => lower(x.name) === lower(name))) st.tags.push({name}); };
    count(st, g, 0);
    if (g.kind === "diff") {
      const name = uniqueName(st, g.name);
      st.signals.push({id: uid(), name, kind: "diff", legs: [{polarity: 1, nets: [g.positive]}, {polarity: -1, nets: [g.negative]}], intent, origin: "suggestion"});
      return t("intent.done.pair", {name, positive: g.positive, negative: g.negative});
    }
    if (g.kind === "bus") {
      const ids = [];
      for (const m of g.members) {
        let s = st.signals.find(x => x.kind === "single" && x.legs?.[0]?.nets?.includes(m.net));
        if (!s) { s = {id: uid(), name: uniqueName(st, m.net), kind: "single", legs: [{nets: [m.net]}], origin: "suggestion"}; st.signals.push(s); }
        ids.push(s.id);
      }
      const name = uniqueName(st, g.name);
      st.signals.push({id: uid(), name, kind: "bus", members: ids, intent: {...intent, range: g.range}, origin: "suggestion"});
      return t("intent.done.bus", {name, count: ids.length});
    }
    for (const tag of g.tags || []) addTag(tag);
    const s = st.signals.find(x => x.kind === "single" && x.legs?.length === 1 && x.legs[0].nets.length === 1 && x.legs[0].nets[0] === g.net);
    if (s) { s.intent = {...(plain(s.intent) ? s.intent : {}), ...intent}; s.tags = [...new Set([...(s.tags || []), ...(g.tags || [])])]; }
    else st.signals.push({id: uid(), name: uniqueName(st, g.net), kind: "single", legs: [{nets: [g.net]}], span: false, ...(g.tags?.length ? {tags: [...g.tags]} : {}), intent, origin: "suggestion"});
    return t(g.kind === "ground" ? "intent.done.ground" : "intent.done.rail", {net: g.net});
  }
  const accept = (project, g) => S().edit(project, st => acceptInto(st, g));
  const acceptAll = (project, list) => S().edit(project, st => { let n = 0; for (const g of list) { acceptInto(st, g); n++; } return n + " suggestions accepted"; });
  function declineInto(st, g) {
    st.declined = {...(plain(st.declined) ? st.declined : {}), [g.key]: {date: today(), kind: g.kind, name: String(g.name || "").slice(0, 120), ...(g.pattern ? {pattern: g.pattern} : {})}};
    count(st, g, 1);
    return t("intent.done.declined", {name: g.name});
  }
  const decline = (project, g) => S().edit(project, st => declineInto(st, g));
  function restore(project, key) {
    return S().edit(project, st => {
      const d = {...(plain(st.declined) ? st.declined : {})}, keys = key ? [key] : Object.keys(d);
      for (const k of keys) delete d[k];
      if (Object.keys(d).length) st.declined = d; else delete st.declined;
      return t("intent.done.restored", {count: keys.length});
    });
  }
  // fn(conventions) edits a copy of the stored conventions; empty parts are dropped.
  function setConventions(project, fn) {
    return S().edit(project, st => {
      const c = JSON.parse(JSON.stringify(plain(st.conventions) ? st.conventions : {}));
      const msg = fn(c);
      for (const k of Object.keys(c)) { const v = c[k]; if (v == null || Array.isArray(v) && !v.length) delete c[k]; else if (plain(v)) { for (const j of Object.keys(v)) if (v[j] == null || Array.isArray(v[j]) && !v[j].length) delete v[j]; if (!Object.keys(v).length) delete c[k]; } }
      if (Object.keys(c).length) st.conventions = c; else delete st.conventions;
      return msg || t("intent.done.saved");
    });
  }
  // The Naming view's edits: keep (pin a learned value), forget (stop applying it), the dictionary.
  const conventionEdits = {
    keep: (project, id, value) => setConventions(project, c => { c.keep = {...(c.keep || {}), [id]: value}; c.forget = (c.forget || []).filter(x => x !== id); }),
    forget: (project, id) => setConventions(project, c => { if (c.keep) delete c.keep[id]; c.forget = [...new Set([...(c.forget || []), id])]; }),
    reset: (project, id) => setConventions(project, c => { if (c.keep) delete c.keep[id]; c.forget = (c.forget || []).filter(x => x !== id); }),
    addWord: (project, group, kind, word) => setConventions(project, c => {
      const w = upper(String(word || "").trim()); if (!/^[A-Z0-9_+\-.]{1,40}$/.test(w)) fail("A dictionary word is letters, digits, _ - + or . (up to 40).");
      c[group] = {...(c[group] || {}), [kind]: [...new Set([...(c[group]?.[kind] || []), w])].sort(natural)};
    }),
    removeWord: (project, group, kind, word) => setConventions(project, c => { if (c[group]?.[kind]) c[group][kind] = c[group][kind].filter(x => upper(x) !== upper(word)); }),
    set: (project, key, value) => setConventions(project, c => { if (value == null) delete c[key]; else c[key] = value; }),
    stopSuggesting: (project, offer) => setConventions(project, c => {
      const nv = c.never = {...(c.never || {})}, k = offer.kind === "diff" ? "pair" : offer.kind === "bus" ? "bus" : "kinds", v = offer.kind === "diff" || offer.kind === "bus" ? offer.value : offer.kind;
      nv[k] = [...new Set([...(nv[k] || []), v])];
    }),
    clearTally: (project, key) => setConventions(project, c => { if (c.tally) delete c.tally[key]; })
  };

  // ------------------------------------------------------------------ conventions files (export, import with a preview)
  // A project's naming dictionary and choices as a small JSON file, for another project (and, later, the
  // group-wide dictionary of the shared library). Learned counts and declines stay with the project.
  //   {format: "atrium-naming", version: 1, project?, conventions: {keep, forget, stems, never, loneN, rs485}}
  const FILE_FORMAT = "atrium-naming", FILE_VERSION = 1, KEEP_IDS = ["rail", "activeLow", "pair", "bus", "case"];
  function exportConventions(project) {
    const c = storedConventions(project), conv = {};
    if (Object.keys(c.keep).length) conv.keep = JSON.parse(JSON.stringify(c.keep));
    if (c.forget.length) conv.forget = [...c.forget];
    for (const g of ["stems", "never"]) { const o = {}; for (const [k, v] of Object.entries(c[g])) if (v.length) o[k] = [...v].sort(natural); if (Object.keys(o).length) conv[g] = o; }
    if (c.raw.loneN) conv.loneN = c.loneN;
    if (c.raw.rs485) conv.rs485 = c.rs485;
    return {format: FILE_FORMAT, version: FILE_VERSION, ...(project?.name ? {project: String(project.name).slice(0, 120)} : {}), conventions: conv};
  }
  const WORD = /^[A-Z0-9_+\-.]{1,40}$/, KINDS = ["diff", "bus", "rail", "ground"];
  /** @param {any} data */
  function readFile(data) {
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { fail(t("intent.import.bad")); } }
    if (!plain(data) || data.format !== FILE_FORMAT || !plain(data.conventions)) fail(t("intent.import.bad"));
    if (!Number.isInteger(data.version) || data.version > FILE_VERSION) fail(t("intent.import.newer"));
    const c = data.conventions, list = v => Array.isArray(v) ? v.filter(x => typeof x === "string") : [];
    const words = v => [...new Set(list(v).map(x => upper(x.trim())).filter(x => WORD.test(x)))];
    /** @type {{keep: Object<string, any>, forget: string[], stems: Object<string, string[]>, never: Object<string, string[]>, loneN?: string, rs485?: string}} */
    const out = {keep: {}, forget: [], stems: {}, never: {}};
    if (plain(c.keep)) for (const id of KEEP_IDS) { const v = c.keep[id]; if (typeof v === "string" && v.length <= 40 || plain(v) && JSON.stringify(v).length <= 400) out.keep[id] = JSON.parse(JSON.stringify(v)); }
    out.forget = list(c.forget).filter(x => KEEP_IDS.includes(x));
    for (const k of ["rail", "ground", "clock"]) { const w = words(plain(c.stems) ? c.stems[k] : null); if (w.length) out.stems[k] = w; }
    const nv = plain(c.never) ? c.never : {};
    for (const k of ["pair", "bus", "rail", "kinds"]) {
      const w = k === "kinds" ? list(nv.kinds).filter(x => KINDS.includes(x)) : k === "pair" ? list(nv.pair).filter(x => x.length <= 20) : words(nv[k]);
      if (w.length) out.never[k] = [...new Set(w)];
    }
    if (c.loneN === "pair" || c.loneN === "activeLow") out.loneN = c.loneN;
    if (c.rs485 === "A" || c.rs485 === "B") out.rs485 = c.rs485;
    return out;
  }
  // Group revisions contain reusable rules only. In particular they contain no project title,
  // examples, tallies, declines or previously selected group.
  const GROUP_SIZE = 16 * 1024;
  const GROUP_ID = /^[A-Za-z0-9_-]{1,100}$/, REVISION = /^[a-f0-9]{64}$/;
  const STYLES = {activeLow: LOW_STYLES.map(([v]) => v), pair: ["P/N", "P/M", "+/-", "A/B", "t/c", "T/C", "H/L", "DP/DM", "DP/DN", "POS/NEG", "PLUS/MINUS"],
    bus: ["n", "_", "-", ".", "[n]"], case: ["upper", "mixed"]};
  function portableConventions(data) {
    const read = readFile({format: FILE_FORMAT, version: FILE_VERSION, conventions: data}), keep = {};
    const rail = read.keep.rail;
    if (plain(rail) && typeof rail.stem === "string" && /^(?:[A-Z][A-Z0-9]{0,31}[_\-.])?$/.test(rail.stem) &&
        ["", "+", "P", "PP"].includes(rail.sign) && ["V", "."].includes(rail.mark) && typeof rail.zero === "boolean") {
      const style = {stem: rail.stem, sign: rail.sign, mark: rail.mark, zero: rail.zero};
      keep.rail = {...style, id: railId(style)};
    }
    for (const [key, allowed] of Object.entries(STYLES)) if (allowed.includes(read.keep[key])) keep[key] = read.keep[key];
    const unique = values => [...new Set(values)].sort();
    const forget = unique(read.forget.filter(x => keep[x] == null));
    const result = {};
    if (Object.keys(keep).length) result.keep = keep;
    if (forget.length) result.forget = forget;
    for (const group of ["stems", "never"]) {
      const lists = Object.fromEntries(Object.entries(read[group]).map(([key, values]) => [key, unique(values)]));
      if (Object.keys(lists).length) result[group] = lists;
    }
    if (read.loneN) result.loneN = read.loneN;
    if (read.rs485) result.rs485 = read.rs485;
    return result;
  }
  function selectedGroup(raw) {
    const g = raw?.group;
    if (!plain(g) || typeof g.id !== "string" || !GROUP_ID.test(g.id) || typeof g.name !== "string" || !g.name || g.name.length > 120 ||
        typeof g.key !== "string" || !REVISION.test(g.key) || !Number.isSafeInteger(g.rev) || g.rev < 1 ||
        !plain(g.conventions) || JSON.stringify(g.conventions).length > GROUP_SIZE) return null;
    return {...g, conventions: portableConventions(g.conventions)};
  }
  function withGroup(local, group) {
    if (!group) return local;
    const c = group.conventions, keep = {...c.keep, ...local.keep};
    for (const id of local.forget) if (local.keep[id] == null) delete keep[id];
    const forget = [...new Set([...(c.forget || []), ...local.forget])];
    const merge = (key, filter) => Object.fromEntries(Object.entries(local[key]).map(([k, v]) =>
      [k, [...new Set([...v, ...(c[key]?.[k] || []).filter(w => !filter || filter(k, w))])]]));
    // A word explicitly assigned by the project takes precedence over a group dictionary assignment.
    const ownStems = new Set(Object.values(local.stems).flat().map(upper));
    const excludedRails = new Set(local.never.rail.map(upper));
    return storedConventions(null, {keep, forget, stems: merge("stems", (_, w) => !ownStems.has(w) && !excludedRails.has(w)),
      never: merge("never", (k, w) => k !== "rail" || !ownStems.has(w)), loneN: local.raw.loneN || c.loneN, rs485: local.raw.rs485 || c.rs485});
  }
  function groupProposal(project) {
    const data = exportConventions(project).conventions, C = conventions(project);
    for (const c of C.localCards) if (c.status === "learned") {
      const v = c.id === "rail" ? C.railStyles.get(c.value) : c.value;
      if (v != null) (data.keep ||= {})[c.id] = v;
    }
    if (!data.loneN && C.loneN.status === "learned") data.loneN = C.loneN.value;
    return portableConventions(data);
  }
  // A project opts in to one approved revision. The adopted rules remain usable offline and
  // reproducible across project copies. Approving a later revision in the library leaves that choice intact.
  function useGroupConventions(project, id) {
    if (id == null) return setConventions(project, c => { delete c.group; return t("intent.done.group_off"); });
    const source = G.AtriumGroupLocal?.libraries().find(lib => lib.id === id);
    if (!source?.naming) fail(t("intent.group.unavailable"));
    const {key, rev, conventions: data} = source.naming;
    return setConventions(project, c => {
      c.group = {id, name: source.name, key, rev, conventions: portableConventions(data)};
      return t("intent.done.group_on", {group: source.name, rev});
    });
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // What importing a file would change: changes [{group, key, kind: add | replace | keep, from?, to}] and the
  // merged conventions. Words are added to this project's; a choice the file makes differently replaces this
  // project's, unless o.prefer is "project" (then it is listed as kept).
  /** @param {any} project @param {any} data @param {{prefer?: string}} [o] */
  function planImport(project, data, o = {}) {
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { fail(t("intent.import.bad")); } }
    const file = readFile(data), mine = storedConventions(project), merged = JSON.parse(JSON.stringify(plain(project?.signals?.conventions) ? project.signals.conventions : {}));
    const changes = [], fileWins = o.prefer !== "project";
    for (const g of ["stems", "never"]) for (const [k, words] of Object.entries(file[g])) {
      const norm = x => g === "never" && (k === "pair" || k === "kinds") ? x : upper(x), have = new Set((mine[g][k] || []).map(norm));
      const add = words.filter(w => !have.has(norm(w)));
      for (const w of add) changes.push({group: g, key: k, kind: "add", to: w});
      if (add.length) merged[g] = {...(merged[g] || {}), [k]: [...(mine[g][k] || []), ...add].sort(natural)};
    }
    for (const [id, v] of Object.entries(file.keep)) {
      const cur = mine.keep[id];
      if (cur == null) { changes.push({group: "keep", key: id, kind: "add", to: v}); merged.keep = {...(merged.keep || {}), [id]: v}; merged.forget = (merged.forget || []).filter(x => x !== id); }
      else if (!same(cur, v)) { changes.push({group: "keep", key: id, kind: fileWins ? "replace" : "keep", from: cur, to: v}); if (fileWins) merged.keep = {...(merged.keep || {}), [id]: v}; }
    }
    for (const id of file.forget) if (!mine.forget.includes(id) && merged.keep?.[id] == null) { changes.push({group: "forget", key: id, kind: "add", to: id}); merged.forget = [...new Set([...(merged.forget || []), id])]; }
    const inherited = selectedGroup(mine.raw)?.conventions;
    for (const k of ["loneN", "rs485"]) {
      if (file[k] == null) continue;
      const cur = mine.raw[k] ? mine[k] : null;
      if (cur == null) { if (file[k] !== (inherited?.[k] || (k === "loneN" ? "activeLow" : "A"))) { changes.push({group: "choice", key: k, kind: "add", to: file[k]}); merged[k] = file[k]; } }
      else if (cur !== file[k]) { changes.push({group: "choice", key: k, kind: fileWins ? "replace" : "keep", from: cur, to: file[k]}); if (fileWins) merged[k] = file[k]; }
    }
    if (merged.forget && !merged.forget.length) delete merged.forget;
    return {changes, merged, applies: changes.filter(x => x.kind !== "keep").length, from: plain(data) && typeof data.project === "string" ? data.project : null};
  }
  // One undo step: the merged conventions, as the preview showed them.
  /** @param {any} project @param {any} data @param {{prefer?: string}} [o] */
  function importConventions(project, data, o = {}) {
    const plan = planImport(project, data, o);
    if (!plan.applies) return t("intent.done.imported", {count: 0});
    return setConventions(project, c => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, JSON.parse(JSON.stringify(plan.merged))); return t("intent.done.imported", {count: plan.applies}); });
  }

  // ------------------------------------------------------------------ Create from nets (Signals panel)
  // Chosen nets become a differential pair (two nets, polarity by name; or every name pair among more nets),
  // a bus (natural order) or a tag on each net: one AtriumSignals.edit, the same records and counts as
  // accepting the matching suggestion (intent confirmed, source "user").
  const orderedNets = o => [...new Set((o.nets || []).map(n => String(n || "").trim()).filter(Boolean))];
  /** @param {{kind?: string, nets?: string[], name?: string, tag?: string}} o */
  function planCreate(o = {}) {
    const order = orderedNets(o), nets = [...order].sort(natural), NI = N(), kind = o.kind || "diff", name = String(o.name || "").trim(), stamp = {source: "user"};
    if (kind === "tag") return nets.length ? [{kind: "tag", name: String(o.tag || name).trim(), nets}] : [];
    if (kind === "bus") {
      if (nets.length < 2) return [];
      const rs = nets.map(n => NI.read(n)), idx = rs.map(r => r.index).filter(Number.isFinite), stem = rs[0].stem || nets[0].replace(/[_\-.[]*\d+\]?$/, "");
      return [{kind: "bus", name: name || stem || nets[0], stem: upper(stem || nets[0]), members: nets.map(net => ({net})), nets, range: idx.length ? [Math.min(...idx), Math.max(...idx)] : undefined, intent: {role: "busMember", ...stamp}}];
    }
    const diff = (pos, neg, pattern, known, n) => ({kind: "diff", name: n, positive: pos, negative: neg, pattern: pattern || "", known, intent: {role: "pairMember", ...(NI.read(pos).protocol ? {protocol: NI.read(pos).protocol} : {}), ...stamp}});
    if (nets.length === 2) {
      const or = NI.orient(nets);
      const pos = or?.positive || order[0], neg = or?.negative || order[1];
      return [diff(pos, neg, or?.pattern, !!or && or.known !== false, name || NI.read(pos).stem || pos)];
    }
    return nets.length > 2 ? NI.pairs(nets, [], {min: "weak"}).map(p => diff(p.positive, p.negative, p.pattern, p.known !== false, p.name)) : [];
  }
  /** @param {{kind?: string, nets?: string[], name?: string, tag?: string}} o */
  function checkedCreate(o) {
    const nets = orderedNets(o), kind = o.kind || "diff";
    if (!nets.length) fail(t("intent.create.nets"));
    const plan = planCreate(o);
    if (kind === "tag" && !plan[0]?.name) fail(t("intent.create.tag"));
    if (!plan.length) fail(t(kind === "bus" ? "intent.create.bus" : nets.length > 2 ? "intent.create.none" : "intent.create.two"));
    return plan;
  }
  /** @param {any} project @param {{kind?: string, nets?: string[], name?: string, tag?: string}} o */
  function createFrom(project, o = {}) {
    const plan = checkedCreate(o);
    if (o.kind === "tag") {
      const {name, nets} = plan[0];
      return S().edit(project, st => {
        st.tags ||= []; st.nets ||= {};
        const existing = st.tags.find(x => lower(x.name) === lower(name)), tag = existing?.name || name;
        if (!existing) st.tags.push({name: tag});
        for (const n of nets) {
          const r = Object.hasOwn(st.nets, n) ? st.nets[n] : null;
          if (Array.isArray(r)) { const x = r.find(q => !q.boards); if (x) x.tags = [...new Set([...(x.tags || []), tag])]; else r.push({tags: [tag]}); }
          else Object.defineProperty(st.nets, n, {value: {...(r || {}), tags: [...new Set([...(r?.tags || []), tag])]},
            enumerable: true, writable: true, configurable: true});
        }
        return t("intent.done.tagged", {count: nets.length, tag});
      });
    }
    return S().edit(project, st => plan.map(g => acceptInto(st, g)).join("; "));
  }

  // ------------------------------------------------------------------ completion
  // Names for the label, port or power port being named: existing nets (by use), the missing partner of a
  // pair member, the next or missing member of a bus, and the typed text in the project's style (3.3 ->
  // 3V3, rst -> nRST). Matching is case-insensitive; the first one that starts with the typed text is the
  // inline completion (Tab accepts it).
  function complete(project, typed, o = {}) {
    const F = facts(project, o.defs), conv = conventions(project, F).effective, NI = N(), q = String(typed ?? "").trim(), Q = upper(q), kind = o.kind || "netlabel";
    const out = new Map(), add = (name, why, score) => { if (!name || name === q) return; const p = out.get(name); if (!p || p.score < score) out.set(name, {name, why, score}); };
    const starts = n => !Q || upper(n).startsWith(Q);
    const power = kind === "power";
    const stems = new Map();
    for (const [name, e] of F.names) {
      const r = classify(name, conv);
      if (r.role === "auto" || r.role === "nc") continue;
      const supply = r.role === "rail" || r.role === "ground";
      if (starts(name)) add(name, t("intent.complete.used", {count: e.n}), 10 + Math.log2(1 + e.n) + (power ? (supply ? 8 : -6) : supply ? -2 : 0) + (upper(name) === Q ? 5 : 0));
      const p = pairMember(r, conv);
      if (p) for (const x of p.partners.slice(0, 1)) if (!F.names.has(x) && starts(x) && !power) add(x, t("intent.complete.partner", {name}), 34);
      if (Number.isFinite(r.index) && r.stem && !supply && r.role !== "pairMember") { let s = stems.get(r.stem); if (!s) stems.set(r.stem, s = []); s.push([r.index, name]); }
    }
    if (!power) for (const list of stems.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a[0] - b[0]);
      const have = new Set(list.map(x => x[0])), lo = list[0][0], hi = list.at(-1)[0], [, ex] = list.at(-1);
      const make = i => ex.replace(/\d+(?=\]?$)/, String(i)), range = {from: list[0][1], to: ex};
      let gaps = 0;
      for (let i = lo; i < hi && gaps < 2; i++) if (!have.has(i)) { gaps++; const n = make(i); if (starts(n)) add(n, t("intent.complete.gap", range), 33); }
      const next = make(hi + 1); if (starts(next)) add(next, t("intent.complete.next", range), 32);
    }
    // The typed text in the project's style.
    if (q) {
      const rail = conv.rail || (power ? {stem: "", sign: "+", mark: "V", zero: false} : null), m = /^([+-]|P|N)?\s*(\d+(?:[.,]\d+)?)\s*(?:V(\d*))?$/i.exec(q);
      if (rail && m && (power || /[vV.,]/.test(q))) {
        let v = +(m[2].replace(",", ".") + (m[3] ? "." + m[3] : "")); if (m[3] && /[.,]/.test(m[2])) v = NaN;
        if (/^[-N]$/i.test(m[1] || "")) v = -v;
        if (Number.isFinite(v) && v !== 0 && Math.abs(v) < 1e4) add(renderRail(v, rail), t("intent.complete.rail", {volts: String(v)}), power ? 40 : 24);
      }
      let bare = q.replace(/^(?:n(?=[A-Z])|~\{|[/!~\\])/, "").replace(/(?:\}|#|[_\-][NnBbLl])$/, "");
      if (/[A-Z]n$/.test(bare)) bare = bare.slice(0, -1);
      const low = conv.activeLow;
      if (low && !power && bare && NI.read(upper(bare)).role === "control") add(renderLow(bare, low), t("intent.complete.low"), 26);
      if (conv.upper && /[a-z]/.test(q.replace(/^n(?=[A-Z])/, "")) && !out.size) add(upper(q), t("intent.complete.case"), 8);
    }
    return [...out.values()].sort((a, b) => b.score - a.score || natural(a.name, b.name)).slice(0, o.limit || 8);
  }

  // ------------------------------------------------------------------ MCP (signals op: suggest, conventions, complete)
  function headless(a, H) {
    const p = H.project();
    if (a.action === "conventions") { const c = conventions(p); return {learned: c.learned.map(x => ({...x})), lone_n: c.effective.loneN, rs485_positive: c.effective.rs485, dictionary: c.stored.stems, never: c.stored.never, offers: offers(p)}; }
    if (a.action === "complete") return {typed: a.name || "", kind: a.name_kind || "netlabel", completions: complete(p, a.name || "", {kind: a.name_kind, limit: 12}).map(({name, why}) => ({name, why}))};
    return null;
  }

  return Object.freeze({facts, conventions, storedConventions, classify, suggest, offers, complete, accept, acceptAll, decline, restore, setConventions, conventionEdits,
    exportConventions, planImport, importConventions, createFrom, planCreate, checkedCreate, localTerminals, regulatorVoltages, regulatorMatchesName, closeVoltage,
    portableConventions, groupProposal, useGroupConventions,
    acceptInto, declineInto, renderRail, railStyleOf, renderLow, lowStyleOf, hash, headless, stats: () => ({...stats}), resetStats: () => { stats = {sheets: 0, boards: 0, patched: 0, reused: 0, buckets: 0}; }});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumNetIntentIndex;
