"use strict";
// Canonical netlist v1. One declaration per line. Names use simple ASCII atoms or JSON
// strings. Sorting uses UTF-16 code units and never depends on the host locale or time.
globalThis.AtriumNetlistText = (() => {
  const G = globalThis, compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const atom = s => /^[A-Za-z0-9_+/-]+$/.test(s) ? s : JSON.stringify(String(s));
  const names = xs => [...new Set(xs)].sort(compare);
  const list = xs => "[" + xs.join(", ") + "]";
  const nameList = xs => list(names(xs).map(atom));
  const boards = p => p.documents.filter(d => d.kind === "pcb").sort((a,b) => compare(a.name,b.name) || compare(a.id,b.id));
  const types = () => G.AtriumNetlist.pinTypes;

  function compile(project, options = {}) {
    const layouts = boards(project), board = options.board == null ? layouts[0] : layouts.find(d => d.id === options.board);
    if (options.board != null && !board) throw Error("The selected PCB document is missing.");
    const sheets = project.documents.filter(d => d.kind === "schematic");
    const schematic = sheets.length && (!board || sheets.some(d => d.items.some(i => i.kind === "part")));
    const defs = options.defs || new Map(project.library.map(d => [d.id,d]));
    const hier = schematic ? G.AtriumHierarchy.compile(project,{defs,local:options.local}) : null;
    const origins = new Map(), onPart = (ref, doc, part) => {
      if (!options.navigation) return;
      const physical = String(ref).trim().toUpperCase();
      if (!origins.has(physical)) origins.set(physical, []);
      origins.get(physical).push({doc, part});
    };
    const n = board || schematic ? G.AtriumNetlist.extract(project,{source:schematic ? "schematic" : "pcb", board:board?.id, defs, hierarchy:hier, onPart}) :
      {components:[], nets:[], source:"schematic", issues:[]};
    const groups = [["netlist 1"]], components = n.components.slice().sort((a,b) => compare(a.ref,b.ref));
    groups.push(components.map(c => "part " + atom(c.ref) + " device " + atom(c.part || "") + " value " + atom(c.value || "") + " footprint " + atom(c.footprint || "") +
      " pins " + list(c.pins.slice().sort((a,b) => compare(a.number,b.number)).map(p => atom(p.number) + ":" + p.type))));
    const nets = new Map(n.nets.map(net => [net.name,net.nodes]));
    // Include named wire-only or copper-only nets even when they have no part pins.
    const declare = name => { if (name && !nets.has(name)) nets.set(name,[]); };
    if (hier) for (const net of hier.nets) declare(net.name);
    else if (board) for (const i of board.items) { declare(i.net); for (const net of Object.values(i.pinNets || {})) declare(net); }
    groups.push(names(nets.keys()).map(name => {
      const pins = nets.get(name).slice().sort((a,b) => compare(a.ref,b.ref) || compare(a.pin,b.pin));
      return "net " + atom(name) + " = " + list(pins.map(x => atom(x.ref) + "." + atom(x.pin)));
    }));

    // A sheet-only design still has project signals, net tags and schematic directives.
    const M = G.AtriumSignals.model(project, board || {id:"", kind:"pcb", items:[]}, {defs});
    const tags = new Map(), declared = new Set(), tag = name => {
      const key = name.toLowerCase();
      if (!tags.has(key)) tags.set(key, {name, nets:new Set(), signals:new Set()});
      const t=tags.get(key);
      if (!declared.has(key) && compare(name,t.name)<0) t.name=name;
      return t;
    };
    for (const t of M.store.tags || []) { tag(t.name); declared.add(t.name.toLowerCase()); }
    for (const [net,recs] of Object.entries(M.store.nets || {})) for (const r of [].concat(recs)) {
      if (!r.boards || r.boards.includes(board?.id)) for (const t of r.tags) tag(t).nets.add(net);
    }
    const signalNames = new Map(M.signals.map(s => [s.id,s.name]));
    groups.push(M.signals.slice().sort((a,b) => compare(a.name,b.name)).map(s => {
      for (const t of s.tags) tag(t).signals.add(s.name);
      const rhs = s.kind === "bus" ? nameList(s.members.filter(id => signalNames.has(id)).map(id => signalNames.get(id))) :
        s.legs.slice().sort((a,b) => b.polarity - a.polarity).map(l => nameList(l.nets)).join(" | ");
      return "signal " + atom(s.name) + " " + s.kind + " = " + rhs;
    }));
    groups.push([...tags.values()].sort((a,b) => compare(a.name,b.name)).map(t =>
      "tag " + atom(t.name) + " nets " + nameList(t.nets) + " signals " + nameList(t.signals)));
    const text = groups.filter(g => g.length).map(g => g.join("\n")).join("\n\n") + "\n";
    return {text, source:n.source, board:board?.id ?? null, counts:{parts:components.length, nets:nets.size, signals:M.signals.length, tags:tags.size},
      issues:n.issues, ...(options.navigation ? {origins, hierarchy:hier, signals:M} : {})};
  }

  // The line reader annotates the same spans used by the checker and the document's
  // syntax highlighter. start/end are zero-based UTF-16 offsets, end exclusive.
  function readLine(line, maxTokens = 200000) {
    const tokens = [];
    const bad = (message,start,end = start + 1) => { throw Object.assign(Error(message), {start,end}); };
    const lex = /[ \t]+|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[A-Za-z0-9_+/-]+|[[\],:.=|]/gy;
    while (lex.lastIndex < line.length) {
      const start = lex.lastIndex, m = lex.exec(line);
      if (!m) bad(line[start] === '"' ? "Invalid or unterminated quoted string." : "Unexpected character.", start);
      const raw = m[0]; if (/^[ \t]/.test(raw)) continue;
      if (tokens.length >= maxTokens) throw Object.assign(Error("Netlist token limit reached."),{code:"size",start,end:start});
      const kind = raw[0] === '"' ? "string" : /^[A-Za-z0-9_+/-]/.test(raw) ? "atom" : "punct";
      tokens.push({raw, value:kind === "string" ? JSON.parse(raw) : raw, start, end:lex.lastIndex, kind, role:kind});
    }
    let i = 0;
    const next = () => tokens[i] || {start:line.length,end:line.length};
    const expected = what => bad("Expected " + what + ".",next().start,next().end);
    function word(w) {
      if (next().raw !== w) expected(w);
      const t = tokens[i++]; if (t.kind === "atom") t.role = "keyword"; return t;
    }
    function name(role, allowEmpty = false) {
      const t = next();
      if (t.kind !== "atom" && t.kind !== "string" || !allowEmpty && !t.value) expected(role + " name");
      i++; t.role = role; return t;
    }
    function array(entry) {
      word("["); const out = [];
      if (next().raw !== "]") { out.push(entry()); while (next().raw === ",") { i++; out.push(entry()); } }
      word("]"); return out;
    }
    if (!tokens.length) return {tokens};
    const kind = next().raw, row = {kind, tokens};
    if (kind === "netlist") { word("netlist"); word("1"); }
    else if (kind === "part") {
      word(kind); row.name = name("part");
      if (next().raw === "device") { word("device"); row.device = name("value",true); }
      word("value"); row.value = name("value",true);
      word("footprint"); row.footprint = name("value",true); word("pins");
      row.pins = array(() => { const pin = name("pin"); pin.ref = row.name.value; word(":"); return {pin, type:name("type")}; });
    } else if (kind === "net") {
      word(kind); row.name = name("net"); word("=");
      row.pins = array(() => {
        const part = name("part"); word("."); const pin = name("pin"); pin.ref = part.value; pin.net = row.name.value;
        return {part, pin};
      });
    } else if (kind === "signal") {
      word(kind); row.name = name("signal");
      if (!["single","diff","bus"].includes(next().raw)) expected("single, diff or bus");
      row.mode = word(next().raw).value; word("=");
      row.first = array(() => name(row.mode === "bus" ? "signal" : "net"));
      if (row.mode === "diff") { word("|"); row.second = array(() => name("net")); }
    } else if (kind === "tag") {
      word(kind); row.name = name("tag"); word("nets"); row.nets = array(() => name("net"));
      word("signals"); row.signals = array(() => name("signal"));
    } else expected("a netlist, part, net, signal or tag declaration");
    if (i !== tokens.length) expected("the end of the line");
    return row;
  }

  // Compiled net names and pin numbers are exact. Component, signal and tag names
  // follow their project binders (case-insensitive designators and intent names).
  const key = (kind, name) => kind === "part" ? name.toUpperCase() : kind === "signal" || kind === "tag" ? name.toLowerCase() : name;
  function validate(text, options = {}) {
    const diagnostics = [], table = {part:new Map(), net:new Map(), signal:new Map(), tag:new Map()};
    let errors = 0, warnings = 0;
    function report(code, message, line, at = {}, severity = "error") {
      if (severity === "error") errors++; else warnings++;
      if (diagnostics.length < 100) diagnostics.push({code, severity, message, line, column:(at.start ?? 0)+1, endColumn:(at.end ?? at.start ?? 0)+1});
    }
    if (typeof text !== "string" || text.length > 32*1024*1024) {
      report("input","Expected netlist text up to 32 MiB.",1);
      return {valid:false, errors, warnings, diagnostics};
    }
    // Skip blank lines without allocating an array entry for every newline in the input.
    // Bound token objects separately from source bytes. A limit produces a diagnostic.
    let header = false, records = 0, remaining = 1500000, line = 0, start = 0;
    const newline = /\r\n|\r|\n/g;
    while (start < text.length) {
      const end = newline.exec(text), source = text.slice(start,end ? end.index : text.length);
      start = end ? newline.lastIndex : text.length;
      line++;
      let row;
      try { row = readLine(source,Math.min(remaining,200000)); }
      catch (e) {
        report(e.code || "syntax",e.message,line,e);
        if (e.code === "size") return {valid:false, errors, warnings, diagnostics};
        continue;
      }
      if (!row.kind) continue;
      remaining -= row.tokens.length;
      if (row.kind === "netlist") {
        if (header || records) report("header","The version header must occur once before all declarations.",line,row.tokens[0]);
        header = true; continue;
      }
      records++; row.line=line; delete row.tokens;
      const map = table[row.kind], id = key(row.kind,row.name.value);
      if (map.has(id)) { report("duplicate","Duplicate " + row.kind + " " + row.name.value + ".",row.line,row.name); continue; }
      map.set(id,row);
    }
    if (!header) report("header","Missing netlist 1 header.",1);
    function unique(ts, row, label) {
      const seen = new Set();
      for (const t of ts) {
        if (seen.has(key(label,t.value))) report("duplicate","Repeated " + label + " " + t.value + ".",row.line,t);
        seen.add(key(label,t.value));
      }
    }
    const pinTypes = types();
    for (const p of table.part.values()) {
      p.byPin = new Map(); unique(p.pins.map(x => x.pin), p, "pin");
      for (const {pin,type} of p.pins) {
        const t = pinTypes.indexOf(type.value);
        if (t < 0) report("pin-type","Unknown electrical pin type " + type.value + ".",p.line,type);
        p.byPin.set(pin.value,t);
      }
    }
    const assigned = new Map(), matrix = options.matrix || G.AtriumERC?.MATRIX || {};
    for (const net of table.net.values()) {
      const firstOfType = new Map(), reportedPairs = new Set();
      for (const {part,pin} of net.pins) {
        const p = table.part.get(key("part",part.value));
        if (!p) { report("unknown-part","Unknown part " + part.value + ".",net.line,part); continue; }
        if (!p.byPin.has(pin.value)) { report("unknown-pin",part.value + " has no pin " + pin.value + ".",net.line,pin); continue; }
        const k = JSON.stringify([p.name.value,pin.value]);
        if (assigned.has(k)) { report("pin-assignment",part.value + "." + pin.value + " already belongs to " + assigned.get(k) + ".",net.line,pin); continue; }
        assigned.set(k,net.name.value);
        const t = p.byPin.get(pin.value);
        if (t < 0) continue;
        for (const [other,otherName] of firstOfType) {
          // As in ERC, one finding per pair of electrical types on this net.
          const pair = Math.min(t,other) + "," + Math.max(t,other), level = matrix[pair];
          if (!level || level === "No Report" || reportedPairs.has(pair)) continue;
          reportedPairs.add(pair);
          report("pin-matrix",otherName + " and " + part.value + "." + pin.value + " connect " +
            pinTypes[other] + " and " + pinTypes[t] + " on " + net.name.value + ".",net.line,pin,level === "Warning" ? "warning" : "error");
        }
        if (!firstOfType.has(t)) firstOfType.set(t,part.value+"."+pin.value);
      }
    }
    function refs(tokens, kind, row) {
      unique(tokens,row,kind);
      for (const t of tokens) if (!table[kind].has(key(kind,t.value))) report("unknown-"+kind,"Unknown " + kind + " " + t.value + ".",row.line,t);
    }
    const owners = new Map();
    for (const s of table.signal.values()) {
      if (s.mode === "bus") { refs(s.first,"signal",s); continue; }
      for (const leg of [s.first,s.second].filter(Boolean)) {
        refs(leg,"net",s);
        if (!leg.length) report("empty-leg","A signal leg needs at least one net.",s.line,s.name);
        for (const t of leg) {
          if (owners.has(t.value)) report("signal-membership",t.value + " already belongs to a leg of " + owners.get(t.value) + ".",s.line,t);
          else owners.set(t.value,s.name.value);
        }
      }
    }
    // Iterative DFS: an untrusted chain of nested buses cannot exhaust the JS stack.
    const active = new Set(), done = new Set();
    for (const s of table.signal.values()) {
      if (s.mode !== "bus" || done.has(s)) continue;
      const stack = [{s,i:0}]; active.add(s);
      while (stack.length) {
        const frame = stack[stack.length-1], t = frame.s.first[frame.i++];
        if (!t) { done.add(frame.s); active.delete(frame.s); stack.pop(); continue; }
        const child = table.signal.get(key("signal",t.value)); if (child?.mode !== "bus" || done.has(child)) continue;
        if (active.has(child)) { report("bus-cycle","Bus membership cycles through " + t.value + ".",frame.s.line,t); continue; }
        active.add(child); stack.push({s:child,i:0});
      }
    }
    for (const t of table.tag.values()) { refs(t.nets,"net",t); refs(t.signals,"signal",t); }
    return {valid:!errors, errors, warnings, diagnostics};
  }
  return Object.freeze({compile, validate, readLine, boards});
})();
