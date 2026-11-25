"use strict";
// Signals panel (Window › Panels › Signals): one place for nets, differential pairs, xSignals, net classes
// and their tags (docs/design/signal-model.md §10). It lists the board's signals (declared in the Signals
// store, from schematic directives, or the legacy classes and pairs read as signals), their legs, nets and
// the series parts they cross; tags with their members; name-based suggestions (net-intent.js) to accept or
// decline; and the issues the model reports (span conflicts, unpaired stages, assumed polarity).
// Every change is one undo step through AtriumSignals.edit. Signals from schematic directives are read-only
// here: Go to directive, or Detach (makes it a stored signal; the directive is removed in the same step).
//
//   AtriumSignalsPanel.rows(project, board, {query, filter}) -> view model rows (headless; tests)
//   AtriumSignalsPanel.actions: newSignal, makeDiff, flip, tag, untag, rename, split, merge, remove, accept,
//     decline, detach, createFromNets: (project, board, ...) -> message (DOM-free; called inside host.edit)
//   Create from nets… (Altium's Create From Nets): an inline chooser (no pop-up) of the board's nets, checked
//     from the selection; makes a differential pair, a bus or a tagged group with a preview, in one undo step.
//   AtriumSignalsPanel.toggle(host, show), install(host)
// Lazy (app/lazy.js "AtriumSignalsPanel", action "signals-panel").
globalThis.AtriumSignalsPanel = (() => {
  const G = globalThis, S = () => G.AtriumSignals || fail("Signals are not loaded.");
  const fail = m => { throw Error(m); };
  const lower = s => String(s).toLowerCase();
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"});
  const KIND = {single: "Single-ended", diff: "Differential", bus: "Bus"};
  const boardOf = (project, doc) => doc?.kind === "pcb" ? doc : project?.documents?.find(d => d.kind === "pcb") || null;
  const uid = () => G.Atrium.id();

  // ------------------------------------------------------------------ view model (DOM-free)
  const declared = project => project?.signals?.declined || {};
  // Common-mode chokes: a 4-pin L / FL / T / CMC part with one pin on each leg of a declared differential signal
  // carries the pair through when its two other pins' nets pair up by name (net-intent.js). The pin map
  // (pin on + ↔ pin to the next + net, same for −) is offered as a series override (store.series), never applied
  // by itself.
  const CHOKE = /^(L|FL|T|CMC|TR)\d/i;
  function chokeSuggestions(project, M, declinedKeys) {
    const N = G.AtriumNetIntent, out = [], store = project?.signals;
    if (!N?.pairs) return out;
    for (const sig of M.signals) {
      if (sig.kind !== "diff") continue;
      const P = new Set(sig.legs.find(l => l.polarity === 1)?.nets || []), Q = new Set(sig.legs.find(l => l.polarity === -1)?.nets || []);
      for (const part of M.index.parts.values()) {
        if (!CHOKE.test(String(part.ref || "")) || store?.series?.[part.id] !== undefined || part.parameters?.SeriesPins != null) continue;
        const pins = Object.entries(part.pinNets || {}).filter(([, n]) => n);
        if (pins.length !== 4) continue;
        const onP = pins.filter(([, n]) => P.has(n)), onN = pins.filter(([, n]) => Q.has(n)), rest = pins.filter(([, n]) => !P.has(n) && !Q.has(n));
        if (onP.length !== 1 || onN.length !== 1 || rest.length !== 2 || rest[0][1] === rest[1][1]) continue;
        const pr = N.pairs(rest.map(([, n]) => n))[0];
        if (!pr) continue;
        const toP = rest.find(([, n]) => n === pr.positive), toN = rest.find(([, n]) => n === pr.negative);
        if (!toP || !toN) continue;
        const pinMap = [[onP[0][0], toP[0]], [onN[0][0], toN[0]]];
        const key = "series:" + S().hash([part.id, ...pinMap.flat()]).slice(3);
        if (declinedKeys[key]) continue;
        out.push({key, kind: "series", name: part.ref, part: part.id, ref: part.ref, signal: sig.name, pins: pinMap, level: "likely",
          why: part.ref + " joins both legs of " + sig.name + ": pins " + pinMap.map(x => x.join("–")).join(" and ") + " carry it to " + pr.positive + " / " + pr.negative + "."});
      }
    }
    return out;
  }
  function suggestions(project, board, M) {
    // Pairs, buses, rails and grounds from the project's names and pins (net-intent-index.js, docs/design/net-intent.md P1).
    const X = G.AtriumNetIntentIndex;
    if (X?.suggest) return [...X.suggest(project, {used: new Set(M.byNet.keys())}), ...chokeSuggestions(project, M, declared(project))];
    const N = G.AtriumNetIntent, out = [];
    if (!N?.pairs) return out;
    const used = new Set(); for (const s of M.signals) for (const l of s.legs || []) for (const n of l.nets) used.add(n);
    const nets = new Set(); for (const i of board.items || []) { if (i.net) nets.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
    const declined = declared(project);
    for (const p of N.pairs([...nets].filter(n => !used.has(n)))) {
      const key = "diff:" + S().hash([p.positive, p.negative].sort()).slice(3);
      if (declined[key]) continue;
      out.push({key, kind: "diff", name: p.name, positive: p.positive, negative: p.negative, level: p.level || "likely", why: (p.explain || []).join("; ")});
    }
    out.push(...chokeSuggestions(project, M, declared(project)));
    return out.sort((a, b) => natural(a.name, b.name));
  }
  function rows(project, board, o = {}) {
    const M = S().model(project, board), q = lower(o.query || "").trim(), f = o.filter || "all";
    const match = (...texts) => !q || texts.some(t => lower(t).includes(q));
    const out = [];
    if (f === "all" || KIND[f]) for (const s of [...M.signals].sort((a, b) => natural(a.name, b.name))) {
      if (KIND[f] && s.kind !== f) continue;
      const nets = s.kind === "bus" ? [...M.netsOfSignal(s.name)] : s.legs.flatMap(l => l.nets);
      if (!match(s.name, ...nets, ...s.tags)) continue;
      out.push({type: "signal", id: s.id, name: s.name, kind: s.kind, tags: [...s.tags], derived: !!s.derived, origin: s.decl.origin || null, nets,
        legs: (s.legs || []).map(l => ({polarity: l.polarity ?? null, nets: [...l.nets], parts: (l.parts || []).map(x => x.ref || x.id)})),
        members: s.members ? s.members.map(id => M.byId.get(id)?.name || id) : null, paths: (s.decl.paths || []).map(p => p.name),
        span: s.legs?.length ? s.legs.map(l => l.nets.join(" ─ ")).join(" | ") : ""});
    }
    if (f === "all" || f === "tags") {
      const tags = new Map();
      for (const t of M.store.tags || []) tags.set(lower(t.name), {name: t.name, color: t.color || "", nets: new Set()});
      for (const n of new Set([...M.byNet.keys(), ...Object.keys(M.store.nets || {})])) for (const t of M.tagNames(n)) { if (!tags.has(lower(t))) tags.set(lower(t), {name: t, color: "", nets: new Set()}); tags.get(lower(t)).nets.add(n); }
      for (const t of [...tags.values()].sort((a, b) => natural(a.name, b.name))) if (match(t.name)) out.push({type: "tag", name: t.name, color: t.color, nets: [...t.nets].sort(natural)});
    }
    if (f === "all" || f === "suggestions") for (const s of suggestions(project, board, M)) if (match(s.name, ...(s.members ? s.members.map(m => m.net) : [s.positive || "", s.negative || "", s.signal || ""]))) out.push({type: "suggestion", ...s});
    if (f === "all" || f === "issues") for (const i of M.issues) if (match(i.text)) out.push({type: "issue", ...i});
    return out;
  }

  // ------------------------------------------------------------------ actions (DOM-free; call inside host.edit)
  const signalIn = (st, id) => st.signals.find(s => s.id === id) || fail("The signal is not in the Signals store.");
  const nameFree = (st, name, except) => { if (!name || !name.trim()) fail("Name the signal."); if (st.signals.some(s => s.id !== except && lower(s.name) === lower(name))) fail("A signal is already named " + name + "."); return name.trim(); };
  const actions = {
    // nets: [net]; two nets with polarity known give a diff signal when kind is "diff".
    /** @param {any} project @param {any} board @param {{name?:string, nets?:string[], kind?:string, tags?:string[]}} o */
    newSignal(project, board, o) {
      const {name, nets, kind = "single", tags} = o;
      if (!nets?.length) fail("Choose a net, track or pad first.");
      return S().edit(project, st => {
        if (kind === "diff") {
          if (nets.length !== 2) fail("A differential signal needs two nets.");
          const o = G.AtriumNetIntent?.orient?.(nets) || {positive: nets[0], negative: nets[1]};
          st.signals.push({id: uid(), name: nameFree(st, name || o.positive.replace(/[_+-]?(?:P|DP|N|DM)$/i, "") || nets[0]), kind: "diff", legs: [{polarity: 1, nets: [o.positive]}, {polarity: -1, nets: [o.negative]}], ...(tags?.length ? {tags} : {}), origin: "user"});
        } else st.signals.push({id: uid(), name: nameFree(st, name || nets[0]), kind: "single", legs: [{nets: [...new Set(nets)]}], ...(tags?.length ? {tags} : {}), origin: "user"});
        return "Signal " + st.signals.at(-1).name + " declared";
      });
    },
    // Two single-ended signals (or two nets) become one differential signal.
    /** @param {any} project @param {any} board @param {{ids?:string[], nets?:string[], name?:string}} o */
    makeDiff(project, board, o) {
      const {ids, nets, name} = o;
      return S().edit(project, st => {
        let pair = nets ? [...nets] : null, keep = null;
        if (ids?.length === 2) { const [a, b] = ids.map(id => signalIn(st, id)); if (a.kind !== "single" || b.kind !== "single") fail("Choose two single-ended signals."); pair = [a.legs[0].nets[0], b.legs[0].nets[0]]; keep = a; st.signals.splice(st.signals.indexOf(b), 1); }
        if (pair?.length !== 2) fail("Choose two nets or two signals.");
        const o = G.AtriumNetIntent?.orient?.(pair) || {positive: pair[0], negative: pair[1]};
        const rec = keep || {id: uid(), origin: "user"};
        Object.assign(rec, {name: nameFree(st, name || keep?.name || o.positive, rec.id), kind: "diff", legs: [{polarity: 1, nets: [o.positive]}, {polarity: -1, nets: [o.negative]}]});
        if (!keep) st.signals.push(rec);
        return "Differential signal " + rec.name + " (+ " + o.positive + ", − " + o.negative + ")";
      });
    },
    flip(project, board, {id}) {
      return S().edit(project, st => { const s = signalIn(st, id); if (s.kind !== "diff") fail("Only a differential signal has polarity."); for (const l of s.legs) l.polarity = -l.polarity; return "Polarity of " + s.name + " flipped"; });
    },
    /** @param {any} project @param {any} board @param {{id?:string, net?:string, tag:string}} o */
    tag(project, board, o) {
      const {id, net, tag} = o;
      if (!tag?.trim()) fail("Name the tag.");
      return S().edit(project, st => {
        const t = tag.trim();
        if (!st.tags.some(x => lower(x.name) === lower(t))) st.tags.push({name: t});
        if (id) { const s = signalIn(st, id); s.tags = [...new Set([...(s.tags || []), t])]; return "Tagged " + s.name + " " + t; }
        const r = st.nets[net] || {tags: []}; if (Array.isArray(r)) fail("This net has board-specific tags; tag its signal instead.");
        st.nets[net] = {...r, tags: [...new Set([...r.tags, t])]}; return "Tagged net " + net + " " + t;
      });
    },
    untag(project, board, {id, tag}) {
      return S().edit(project, st => { const s = signalIn(st, id); s.tags = (s.tags || []).filter(x => lower(x) !== lower(tag)); if (!s.tags.length) delete s.tags; return "Removed tag " + tag + " from " + s.name; });
    },
    rename(project, board, {id, name}) {
      return S().edit(project, st => { const s = signalIn(st, id), was = s.name; s.name = nameFree(st, name, id); return "Renamed " + was + " to " + s.name; });
    },
    // Stop crossing a series part (exclude) or cross it again.
    split(project, board, {id, part, cross = false}) {
      return S().edit(project, st => {
        const s = signalIn(st, id), pid = board.items.find(i => i.kind === "part" && (i.id === part || i.ref === part))?.id || fail("No part " + part + " on the board.");
        const ex = new Set(s.exclude || []);
        if (cross) ex.delete(pid); else ex.add(pid);
        if (ex.size) s.exclude = [...ex]; else delete s.exclude;
        delete s.span;
        return (cross ? s.name + " crosses " : s.name + " no longer crosses ") + part;
      });
    },
    // Two diff signals across a series stage become one; their names are kept as stage names.
    merge(project, board, {ids}) {
      return S().edit(project, st => {
        const [a, b] = (ids || []).map(id => signalIn(st, id));
        if (!a || !b || a.kind !== b.kind || a.kind === "bus") fail("Choose two signals of the same kind.");
        a.stages = [...(a.stages || [a.name]), ...(b.stages || [b.name])];
        a.legs.forEach((l, i) => { const m = b.kind === "diff" ? b.legs.find(x => x.polarity === l.polarity) : b.legs[i]; if (m) l.nets = [...new Set([...l.nets, ...m.nets])]; });
        a.tags = [...new Set([...(a.tags || []), ...(b.tags || [])])]; if (!a.tags.length) delete a.tags;
        if (b.paths?.length) a.paths = [...(a.paths || []), ...b.paths];
        delete a.span;
        for (const s of st.signals) if (s.kind === "bus") s.members = [...new Set(s.members.map(m => m === b.id ? a.id : m))];
        st.signals.splice(st.signals.indexOf(b), 1);
        return "Merged " + b.name + " into " + a.name;
      });
    },
    remove(project, board, {id}) {
      return S().edit(project, st => { const s = signalIn(st, id); st.signals.splice(st.signals.indexOf(s), 1); for (const b of st.signals) if (b.kind === "bus") b.members = b.members.filter(m => m !== id); st.signals = st.signals.filter(x => x.kind !== "bus" || x.members.length); return "Removed signal " + s.name; });
    },
    accept(project, board, {suggestion: g}) {
      if (g.kind === "series") return S().edit(project, st => {
        st.series = {...(st.series || {}), [g.part]: g.pins.map(x => [String(x[0]), String(x[1])])};
        return g.ref + " carries " + g.signal + " (pins " + g.pins.map(x => x.join("–")).join(", ") + ")";
      });
      if (g.members && G.AtriumNetIntentIndex) return G.AtriumNetIntentIndex.accept(project, g);
      return S().edit(project, st => {
        st.signals.push({id: uid(), name: nameFree(st, g.name), kind: "diff", legs: [{polarity: 1, nets: [g.positive]}, {polarity: -1, nets: [g.negative]}], intent: {role: "pairMember", source: "name"}, origin: "suggestion"});
        return "Differential signal " + g.name + " declared";
      });
    },
    // Create from nets (Altium's Create From Nets): the chosen nets become a pair (or every name pair among
    // them), a bus or a tagged group, as accepting the matching suggestion does (net-intent-index.js).
    /** @param {any} project @param {any} board @param {{kind?: string, nets?: string[], name?: string, tag?: string}} o */
    createFromNets(project, board, o) { return (G.AtriumNetIntentIndex || fail("Net intent is not loaded.")).createFrom(project, o); },
    // Every suggestion of one kind (the group's Accept all), as one step.
    acceptAll(project, board, {suggestions: list}) { return G.AtriumNetIntentIndex.acceptAll(project, list); },
    decline(project, board, {suggestion: g}) {
      if (g.members && G.AtriumNetIntentIndex) return G.AtriumNetIntentIndex.decline(project, g);
      return S().edit(project, st => { st.declined = {...(st.declined || {}), [g.key]: {date: new Date().toISOString().slice(0, 10), kind: g.kind}}; return "Suggestion " + g.name + " declined"; });
    },
    // A directive-derived signal becomes a stored one; its directive fields are removed from the sheet.
    detach(project, board, {id}) {
      const M = S().model(project, board), s = M.byId.get(id);
      if (!s?.derived) fail("Only a signal from a schematic directive can be detached.");
      const recs = S().directives(project).records.filter(r => lower(r.signal || r.diffPair || "") === lower(s.name));
      const msg = S().edit(project, st => {
        st.signals.push({id: uid(), name: s.name, kind: s.kind, legs: s.decl.legs.map(l => ({...l, nets: [...l.nets]})), ...(s.tags.length ? {tags: [...s.tags]} : {}), origin: "user"});
        return "Detached " + s.name + " from its schematic directive";
      });
      for (const r of recs) { const sheet = project.documents.find(d => d.id === r.sheet), item = sheet?.items.find(i => i.id === r.item); if (item) for (const k of ["signal", "polarity", "diffPair", "tags"]) delete item[k]; }
      return msg;
    }
  };

  // ------------------------------------------------------------------ MCP (headless.js op "signals")
  // Signals are named; parts by designator. Read actions: list, get, suggest, legacy. Edits: declare,
  // create from PCB nets (or preview), update, flip, merge, split, remove, tag, accept, decline.
  function headless(a, H) {
    const action = a.action || "list", preview = action === "create_from_nets" && a.mode === "plan";
    const read = preview || ["list", "get", "suggest", "legacy", "conventions", "complete"].includes(action);
    const p = read ? H.project() : H.mutable(), board = H.board(p, a.document_id);
    S().attach(p);
    const M = () => S().model(p, board);
    const idOf = name => { const s = M().signals.find(x => lower(x.name) === lower(name || "")); if (!s) fail("No signal is named " + name + "."); if (s.derived && !read) fail("Signal " + s.name + " comes from a schematic directive; edit the directive (or detach it in the Signals panel)."); return s.id; };
    const done = message => { H.touched(); return {document_id: board.id, message, signals: rows(p, board, {filter: "all"}).filter(r => r.type === "signal").length}; };
    if (action === "list") return {document_id: board.id, ...H.page(rows(p, board, {query: a.filter, filter: a.kind || "all"}), a)};
    if (action === "get") { const r = rows(p, board, {filter: "all"}).find(x => x.type === "signal" && lower(x.name) === lower(a.name || "")) || fail("No signal is named " + a.name + "."); const m = M(); return {document_id: board.id, signal: r, stages: m.stages().filter(x => x.id === r.id), paths: m.paths().filter(x => x.id === r.id).map(x => ({name: x.name, auto: x.auto, nets: x.nets || null}))}; }
    if (action === "suggest") return {document_id: board.id, suggestions: suggestions(p, board, M())};
    if ((action === "conventions" || action === "complete") && G.AtriumNetIntentIndex) return {document_id: board.id, ...G.AtriumNetIntentIndex.headless(a, H)};
    if (action === "legacy") return {document_id: board.id, ...M().legacy()};
    if (action === "create_from_nets") {
      const kind = a.kind || "diff", nets = a.nets || [];
      if (!KINDS.some(([id]) => id === kind)) fail("Create from nets needs kind diff, bus or tag.");
      const known = new Set(boardNets(board)), missing = nets.filter(n => !known.has(n));
      if (missing.length) fail("Nets not found on the selected PCB: " + missing.join(", ") + ".");
      const opts = {kind, nets, name: a.name, tag: a.tag};
      return preview ? {document_id: board.id, plan: G.AtriumNetIntentIndex.checkedCreate(opts)} :
        done(actions.createFromNets(p, board, opts));
    }
    if (action === "declare") {
      if (a.legs?.length) return done(S().edit(p, st => {
        const kind = a.kind || (a.legs.length === 2 ? "diff" : "single");
        if (kind === "diff" && (a.legs.length !== 2 || a.legs[0].polarity === a.legs[1].polarity)) fail("A differential signal needs two legs, polarity 1 and -1.");
        st.signals.push({id: uid(), name: nameFree(st, a.name), kind, legs: a.legs.map(l => ({...(kind === "diff" ? {polarity: l.polarity} : {}), nets: [...l.nets]})), ...(a.tags?.length ? {tags: [...a.tags]} : {}), origin: "user"});
        return "Signal " + a.name + " declared";
      }));
      return done(actions.newSignal(p, board, {name: a.name, nets: a.nets, kind: a.kind || (a.nets?.length === 2 ? "diff" : "single"), tags: a.tags}));
    }
    if (action === "update") {
      const id = idOf(a.name);
      return done(S().edit(p, st => {
        const s = signalIn(st, id), ref = r => board.items.find(i => i.kind === "part" && i.ref === r)?.id || fail("No part " + r + " on the board.");
        if (a.new_name) s.name = nameFree(st, a.new_name, id);
        if (a.add_tags?.length || a.remove_tags?.length) { const t = new Set(s.tags || []); for (const x of a.add_tags || []) { t.add(x); if (!st.tags.some(y => lower(y.name) === lower(x))) st.tags.push({name: x}); } for (const x of a.remove_tags || []) t.delete(x); if (t.size) s.tags = [...t]; else delete s.tags; }
        if (a.exclude) { if (a.exclude.length) s.exclude = a.exclude.map(ref); else delete s.exclude; }
        if (a.through) { if (a.through.length) s.through = a.through.map(ref); else delete s.through; }
        if (a.span != null) { if (a.span) delete s.span; else s.span = false; }
        return "Signal " + s.name + " updated";
      }));
    }
    if (action === "flip") return done(actions.flip(p, board, {id: idOf(a.name)}));
    if (action === "merge") return done(actions.merge(p, board, {ids: (a.names || []).map(idOf)}));
    if (action === "split") return done(actions.split(p, board, {id: idOf(a.name), part: a.part, cross: !!a.cross}));
    if (action === "remove") return done(actions.remove(p, board, {id: idOf(a.name)}));
    if (action === "tag") return done(a.name ? actions.tag(p, board, {id: idOf(a.name), tag: a.tag}) : actions.tag(p, board, {net: a.net || fail("Name a signal or a net."), tag: a.tag}));
    if (action === "accept" || action === "decline") {
      const all = suggestions(p, board, M()), g = all.find(x => a.key && x.key === a.key) || all.find(x => lower(x.name) === lower(a.name || "")) || fail("No suggestion is named " + a.name + ".");
      return done(actions[action](p, board, {suggestion: g}));
    }
    fail("Unknown signals action " + action + ". Use list, get, suggest, legacy, conventions, complete, declare, create_from_nets, update, flip, merge, split, remove, tag, accept or decline.");
  }

  // ------------------------------------------------------------------ panel (DOM)
  let host = null, panel = null, ui = null, timer = 0, sel = null;
  const state = {query: "", filter: "all", open: new Set(), input: null, view: "signals"};
  const C = () => G.AtriumNavCommon;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  function btn(text, fn, title, cls = "sig-btn") {
    const b = el("button", text, cls);
    b.type = "button"; b.onclick = fn; if (title) b.title = title;
    return cls === "sig-btn" ? (G.AtriumUI?.button(b, "secondary", "sm") ?? b) : b;
  }
  const ctx = () => { const project = host.project(), board = boardOf(project, host.doc()); return {project, board}; };
  function run(fn) {
    const {project, board} = ctx();
    if (!board) { host.info("Open a board layout: signals live on the board's nets."); return; }
    let msg = "";
    try { host.edit(() => { msg = fn(project, board); }); } catch (e) { host.info(e.message); return; }
    if (msg) host.info(msg);
    paint();
  }
  function selectedNets() {
    const d = host.doc(), ids = new Set(host.selection?.() || []), nets = [];
    for (const i of d.items || []) if (ids.has(i.id)) { if (i.net) nets.push(i.net); else if (i.kind === "netlabel" || i.kind === "port" || i.kind === "power") nets.push(String(i.text || "").trim()); else for (const n of Object.values(i.pinNets || {})) if (n) nets.push(n); }
    return [...new Set(nets.filter(Boolean))];
  }
  function build() {
    const nav = document.getElementById("properties");
    if (!nav) return false;
    panel = el("section", null, "panel panel-signals"); panel.hidden = true; panel.setAttribute("aria-labelledby", "sig-heading");
    const head = el("header", null, "pane-heading"), h2 = el("h2", "Signals"); h2.id = "sig-heading";
    const count = el("span", null, "ui-search-count"), close = btn("×", () => toggle(false), "Close Signals", "ui-close sig-close"); close.setAttribute("aria-label", "Close Signals");
    head.append(h2, close);
    // Two views: the signals, and Naming (how this project's names are read; naming.js).
    const tabs = el("div", null, "sig-tabs ui-tabs"); tabs.dataset.strip = ""; tabs.setAttribute("role", "tablist");
    const tab = (id, text) => { const b = btn(text, () => { state.view = id; paint(); }, null, "sig-tab ui-tab"); b.setAttribute("role", "tab"); b.dataset.view = id; return b; };
    tabs.append(tab("signals", "Signals"), tab("naming", "Naming"));
    const naming = el("div", null, "sig-naming"); naming.hidden = true; naming.setAttribute("role", "tabpanel");
    const tools = el("div", null, "sig-tools");
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Filter signals, nets, tags"; search.setAttribute("aria-label", "Filter signals");
    search.oninput = () => { state.query = search.value; paint(); };
    const filter = el("select", null, "ui-field"); filter.setAttribute("aria-label", "Show");
    for (const [v, t] of [["all", "All"], ["single", "Single-ended"], ["diff", "Differential"], ["bus", "Buses"], ["tags", "Tags"], ["suggestions", "Suggestions"], ["issues", "Issues"]]) { const o = el("option", t); o.value = v; filter.append(o); }
    filter.onchange = () => { state.filter = filter.value; paint(); };
    const find = AtriumUI.searchField(search, {cls: "sig-find", type: true, accessory: count});
    tools.append(find, filter);
    const actionsBar = el("div", null, "sig-actions");
    actionsBar.append(
      btn("New", () => run((p, b) => actions.newSignal(p, b, {nets: selectedNets()})), "New signal from the selected nets, tracks or pads"),
      btn("Make differential", () => run((p, b) => sel?.type === "signal" && ui.second ? actions.makeDiff(p, b, {ids: [sel.id, ui.second]}) : actions.makeDiff(p, b, {nets: selectedNets()})), "Two selected nets (or two single-ended signals, Ctrl+click the second) become one differential signal"),
      btn("Flip", () => sel?.type === "signal" && run((p, b) => actions.flip(p, b, {id: sel.id})), "Swap the polarity of the selected differential signal"),
      btn("Tag…", () => ask("Tag", v => run((p, b) => actions.tag(p, b, sel?.type === "signal" ? {id: sel.id, tag: v} : {net: selectedNets()[0], tag: v}))), "Tag the selected signal (or net)"),
      btn("Rename…", () => sel?.type === "signal" && ask("Name", v => run((p, b) => actions.rename(p, b, {id: sel.id, name: v})), sel.name), "Rename the selected signal"),
      btn("Merge", () => sel?.type === "signal" && ui.second && run((p, b) => actions.merge(p, b, {ids: [sel.id, ui.second]})), "Merge two signals across a series stage (Ctrl+click the second)"),
      btn("Remove", () => sel?.type === "signal" && run((p, b) => actions.remove(p, b, {id: sel.id})), "Remove the selected signal (its nets stay)"),
      btn("Create from nets…", () => openCreate()));
    const create = el("div", null, "sig-create"); create.hidden = true;
    const input = el("div", null, "sig-input"); input.hidden = true;
    const list = el("div", null, "sig-list pane-scroll"); list.setAttribute("role", "tree"); list.setAttribute("aria-label", "Signals"); list.tabIndex = 0;
    panel.append(head, tabs, tools, actionsBar, input, create, list, naming);
    nav.append(panel);
    ui = {count, find, search, filter, list, input, second: null, tabs, tools, actionsBar, naming, create};
    list.addEventListener("keydown", keys);
    const spec = {id: "signals", title: "Signals", element: panel, area: "right", action: "signals-panel"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    return true;
  }
  // An inline field (no pop-up): Enter applies, Escape cancels.
  function ask(label, apply, value = "") {
    const box = ui.input, field = el("input"); field.type = "text"; field.value = value; field.setAttribute("aria-label", label);
    box.replaceChildren(el("span", label, "sig-input-label"), field, btn("OK", () => done(true)), btn("Cancel", () => done(false)));
    box.hidden = false; field.focus(); field.select();
    function done(ok) { box.hidden = true; box.replaceChildren(); if (ok && field.value.trim()) apply(field.value.trim()); ui.list.focus({preventScroll: true}); }
    field.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); done(false); } };
  }
  // Kinds, tags and parts are library chip tokens; a strong suggestion's kind is a success badge.
  function chip(text, cls, tone) { const c = el("span", text, (tone ? "ui-badge " : "ui-chip ") + (cls || "")); if (tone) c.dataset.tone = tone; return c; }
  function rowFor(r) {
    const li = el("div", null, "sig-row sig-" + r.type); li.setAttribute("role", "treeitem");
    if (sel && sel.type === r.type && (sel.id || sel.name) === (r.id || r.name)) li.classList.add("is-selected");
    if (r.type === "signal") {
      const open = state.open.has(r.id); li.setAttribute("aria-expanded", String(open));
      const line = el("div", null, "sig-line");
      line.append(btn(open ? "▾" : "▸", e => { e.stopPropagation(); if (open) state.open.delete(r.id); else state.open.add(r.id); paint(); }, open ? "Collapse" : "Expand", "sig-twisty"),
        el("span", r.name, "sig-name"), chip(KIND[r.kind] || r.kind, "sig-kind"), ...r.tags.map(t => chip(t, "sig-tag")), ...(r.derived ? [chip("from schematic", "sig-derived")] : []),
        el("span", r.kind === "bus" ? (r.members || []).join(", ") : r.span, "sig-span"));
      li.append(line);
      if (open) {
        for (const l of r.legs) {
          const leg = el("div", null, "sig-leg");
          leg.append(el("span", l.polarity === 1 ? "+" : l.polarity === -1 ? "−" : "•", "sig-pol"), el("span", l.nets.join(" ─ "), "sig-nets"), ...l.parts.map(p => chip(p, "sig-part")));
          li.append(leg);
        }
        if (r.paths.length) li.append(el("div", "xSignals: " + r.paths.join(", "), "sig-paths"));
        const more = el("div", null, "sig-more");
        if (r.derived) more.append(btn("Go to directive", () => { const o = r.origin; if (o?.doc) { host.selectDocument?.(o.doc); if (o.item) host.select?.(o.item); } }, "Show the schematic directive"),
          btn("Detach", () => run((p, b) => actions.detach(p, b, {id: r.id})), "Make it a stored signal; the directive fields are removed"));
        else for (const l of r.legs) for (const part of l.parts) more.append(btn("Split at " + part, () => run((p, b) => actions.split(p, b, {id: r.id, part})), "Stop this signal crossing " + part));
        for (const t of r.tags) if (!r.derived) more.append(btn("Untag " + t, () => run((p, b) => actions.untag(p, b, {id: r.id, tag: t}))));
        li.append(more);
      }
    } else if (r.type === "tag") {
      li.append(el("span", r.name, "sig-name"), chip(r.nets.length + (r.nets.length === 1 ? " net" : " nets"), "sig-kind"), el("span", r.nets.slice(0, 8).join(", ") + (r.nets.length > 8 ? " …" : ""), "sig-span"));
    } else if (r.type === "suggestion") {
      const what = {diff: "suggested pair", bus: "suggested bus", rail: "rail", ground: "ground", series: "pin map"}[r.kind] || r.kind;
      const span = r.kind === "bus" ? r.members.map(m => m.net).slice(0, 6).join(", ") + (r.members.length > 6 ? " … " + r.members.at(-1).net : "")
        : r.kind === "rail" ? (r.intent?.voltage != null ? r.intent.voltage + " V" : "") : r.kind === "ground" ? (r.intent?.domain || "") : r.kind === "series" ? r.signal + ": pins " + r.pins.map(x => x.join("–")).join(", ") : "+ " + r.positive + "  − " + r.negative;
      if (r.level) li.classList.add("sig-level-" + r.level);
      li.append(el("span", r.name, "sig-name"), chip(what, "sig-kind", r.level === "strong" ? "success" : null), el("span", span, "sig-span"),
        btn("Accept", () => run((p, b) => actions.accept(p, b, {suggestion: r})), "Declare it as a signal (one undo step). " + (r.why || "")),
        btn("Decline", () => run((p, b) => actions.decline(p, b, {suggestion: r})), "Not right; don't suggest it again (Signals › Naming lists declined suggestions)"));
      if (r.ask || r.basis) li.append(el("span", r.ask || r.basis + (r.level === "strong" ? "" : " · advice until you accept it"), "sig-why"));
    } else li.append(el("span", r.text, "sig-issue-text"));
    li.onclick = e => {
      if (e.ctrlKey || e.metaKey) { ui.second = r.id || null; host.info(r.name ? r.name + " marked as the second signal" : ""); return; }
      sel = r; ui.second = null; const net = r.nets?.[0] || r.positive || r.net; if (net) host.setHighlight?.(net); paint();
    };
    li.ondblclick = () => { const net = r.nets?.[0] || r.positive; const d = host.doc(); const found = net && G.AtriumCrossProbe?.netObjects?.(d, host.defs(), net); if (found?.box) host.zoomTo(found.box); };
    return li;
  }
  // ------------------------------------------------------------------ Create from nets (inline)
  const make = {open: false, kind: "diff", name: "", query: "", nets: new Set()};
  const KINDS = [["diff", "Differential pair"], ["bus", "Bus"], ["tag", "Tagged group"]];
  function boardNets(board) {
    const s = new Set();
    for (const i of board?.items || []) { if (i.net) s.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) s.add(n); }
    return [...s].sort(natural);
  }
  function openCreate() {
    make.open = !make.open;
    if (make.open) { make.nets = new Set(selectedNets()); make.name = ""; make.query = ""; }
    paintCreate();
  }
  function paintCreate() {
    const box = ui.create;
    box.hidden = !make.open || state.view === "naming";
    if (box.hidden) { box.replaceChildren(); return; }
    const {project, board} = ctx(), X = G.AtriumNetIntentIndex, out = [];
    const kinds = el("div", null, "sig-create-row");
    kinds.setAttribute("role", "radiogroup"); kinds.setAttribute("aria-label", "Create");
    for (const [v, text] of KINDS) {
      const l = el("label", null, "sig-radio"), r = el("input");
      r.type = "radio"; r.name = "sig-create-kind"; r.value = v; r.checked = make.kind === v;
      r.onchange = () => { if (r.checked) { make.kind = v; paintCreate(); } };
      l.append(r, el("span", text)); kinds.append(l);
    }
    out.push(kinds);
    const naming = el("label", null, "sig-create-row sig-value-row"), name = el("input", null, "ui-field");
    name.type = "text"; name.value = make.name; name.placeholder = make.kind === "tag" ? "Tag name" : "Name (from the nets when empty)"; name.setAttribute("aria-label", make.kind === "tag" ? "Tag" : "Name");
    name.oninput = () => { make.name = name.value; paintPreview(); };
    naming.append(el("span", make.kind === "tag" ? "Tag" : "Name", "sig-input-label"), name);
    out.push(naming);
    const filter = el("input"); filter.type = "search"; filter.placeholder = "Filter nets"; filter.value = make.query; filter.setAttribute("aria-label", "Filter nets");
    const list = el("div", null, "sig-create-nets");
    list.setAttribute("role", "group"); list.setAttribute("aria-label", "Nets");
    const paintNets = () => {
      const q = lower(make.query).trim(), all = boardNets(board), shown = all.filter(n => !q || lower(n).includes(q) || make.nets.has(n)).slice(0, 400);
      list.replaceChildren(...shown.map(n => {
        const l = el("label", null, "sig-create-net"), c = el("input");
        c.type = "checkbox"; c.checked = make.nets.has(n);
        c.onchange = () => { if (c.checked) make.nets.add(n); else make.nets.delete(n); paintPreview(); };
        l.append(c, el("span", n)); return l;
      }));
      if (!shown.length) list.append(el("p", all.length ? "No net matches." : "This board has no named nets.", "ui-empty sig-empty"));
    };
    filter.oninput = () => { make.query = filter.value; paintNets(); };
    out.push(AtriumUI.searchField(filter, {cls: "sig-find", type: true}), list);
    const preview = el("div", null, "sig-create-preview");
    preview.setAttribute("aria-live", "polite");
    const createBtn = btn("Create", () => run((p, b) => { const msg = actions.createFromNets(p, b, {kind: make.kind, nets: [...make.nets], name: make.name, tag: make.name}); make.open = false; paintCreate(); return msg; }));
    const paintPreview = () => {
      const plan = X?.planCreate ? X.planCreate({kind: make.kind, nets: [...make.nets], name: make.name, tag: make.name}) : [];
      const lines = plan.map(g => g.kind === "diff" ? g.name + ": + " + g.positive + "  − " + g.negative + (g.known ? "" : " (polarity as chosen; Flip swaps it)")
        : g.kind === "bus" ? "Bus " + g.name + ": " + g.nets.length + " nets, " + g.nets[0] + " … " + g.nets.at(-1) : (g.name ? "Tag " + g.name : "Name the tag") + " on " + g.nets.length + " net" + (g.nets.length === 1 ? "" : "s"));
      const empty = !make.nets.size ? "Check the nets to use." : make.kind === "diff" && make.nets.size === 1 ? "Check a second net." : make.kind === "diff" && make.nets.size > 2 && !plan.length ? "None of these pair by their names. Check two nets to pair them anyway." : make.kind === "bus" && make.nets.size < 2 ? "Check two or more nets." : "";
      preview.replaceChildren(...(lines.length ? lines.map(x => el("div", x)) : [el("div", empty, "ui-empty sig-empty")]));
      createBtn.disabled = !plan.length || make.kind === "tag" && !make.name.trim();
    };
    const row = el("div", null, "sig-create-row");
    row.append(createBtn, btn("Cancel", () => { make.open = false; paintCreate(); }));
    out.push(preview, row);
    box.replaceChildren(...out);
    paintNets(); paintPreview();
  }
  function paintNaming() {
    const L = G.AtriumLazy, go = N => { if (state.view === "naming" && !panel.hidden) N.render(ui.naming, host); };
    if (G.AtriumNaming) go(G.AtriumNaming);
    else if (L?.need) L.need("AtriumNaming").then(go, e => ui.naming.replaceChildren(el("p", e.message, "ui-empty sig-empty")));
  }
  // Suggestions grouped by kind, each group with Accept all, and the "stop suggesting" offers first.
  function withGroups(list) {
    const out = [], X = G.AtriumNetIntentIndex, {project} = ctx();
    for (const o of X?.offers?.(project) || []) {
      const r = el("div", null, "sig-offer"), what = o.value ? o.value + " " + ({diff: "pair", bus: "bus"}[o.kind] || o.kind) : o.kind;
      r.append(el("span", "You declined " + o.declined + " " + what + " suggestions and accepted none."),
        btn("Stop suggesting them", () => run(p => X.conventionEdits.stopSuggesting(p, o)), "Signals › Naming lists what is not suggested"), btn("Keep suggesting", () => run(p => X.conventionEdits.clearTally(p, o.key))));
      out.push(r);
    }
    let kind = null;
    const TITLE = {diff: "Suggested pairs", bus: "Suggested buses", rail: "Rails", ground: "Grounds"};
    for (const r of list) {
      if (r.type === "suggestion" && r.members && r.kind !== kind) {
        kind = r.kind;
        const same = list.filter(x => x.type === "suggestion" && x.kind === kind), h = el("div", null, "sig-group");
        h.append(el("span", (TITLE[kind] || kind) + " (" + same.length + ")"));
        if (same.length > 1 && X) h.append(btn("Accept all", () => run((p, b) => actions.acceptAll(p, b, {suggestions: same})), "Declare all " + same.length + " as signals, as one undo step"));
        out.push(h);
      } else if (r.type !== "suggestion") kind = null;
      out.push(rowFor(r));
    }
    return out;
  }
  function paint() {
    clearTimeout(timer); timer = 0;
    if (!panel || panel.hidden) return;
    const naming = state.view === "naming";
    for (const b of ui.tabs.children) {
      const selected = b.dataset.view === state.view;
      b.setAttribute("aria-selected", String(selected)); b.tabIndex = selected ? 0 : -1;
    }
    ui.tools.hidden = ui.actionsBar.hidden = ui.list.hidden = naming; ui.naming.hidden = !naming;
    if (naming || !make.open) ui.create.hidden = true;
    if (naming) { paintNaming(); return; }
    const {project, board} = ctx();
    if (!board) { ui.list.replaceChildren(el("p", "This project has no board layout yet. Signals live on a board's nets; schematic directives (Signal, Polarity, Tags) apply once Update PCB makes the board.", "ui-empty sig-empty")); if (ui.find.setCount) ui.find.setCount(""); else ui.count.textContent = ""; return; }
    let list = [];
    try { list = rows(project, board, state); } catch (e) { ui.list.replaceChildren(el("p", e.message, "ui-empty sig-empty")); return; }
    const counted = String(list.filter(r => r.type === "signal").length);
    if (ui.find.setCount) ui.find.setCount(counted); else ui.count.textContent = counted;
    ui.list.replaceChildren(...(list.length ? withGroups(list.slice(0, 2000)) : [el("p", state.query ? "Nothing matches." : "No signals yet. Select two nets and choose Make differential, or accept a suggestion.", "ui-empty sig-empty")]));
  }
  function keys(e) {
    const items = [...ui.list.querySelectorAll(".sig-row")], i = items.findIndex(x => x.classList.contains("is-selected"));
    const step = {ArrowDown: 1, ArrowUp: -1}[e.key];
    if (step) { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i + step))]?.click(); }
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && sel?.type === "signal") { e.preventDefault(); if (e.key === "ArrowRight") state.open.add(sel.id); else state.open.delete(sel.id); paint(); }
    else if (e.key === "Delete" && sel?.type === "signal" && !sel.derived) { e.preventDefault(); run((p, b) => actions.remove(p, b, {id: sel.id})); }
  }
  function schedule() { if (!panel || panel.hidden || timer) return; timer = setTimeout(paint, 120); }
  function toggle(show) {
    if (!panel && !build()) return false;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on && !G.AtriumDock) document.body.classList.remove("hide-right");
    C()?.setChecked?.("signals-panel", on);
    if (on) { paint(); ui.list.focus({preventScroll: true}); } else host.canvas?.()?.focus?.();
    return on;
  }
  function install(h) {
    if (host === h) return;
    host = h;
    h.registerAction?.("signals-panel", () => toggle());
    for (const ev of ["change", "document"]) h.on?.(ev, schedule);
  }
  if (typeof document !== "undefined") G.AtriumNavCommon?.ready?.(install);

  // The panel open on `query` (a signal or net name): the board's context menu and route bar.
  function show(h, query) {
    if (h) install(h);
    if (!toggle(true)) return false;
    if (query != null) { state.query = String(query); const s = panel.querySelector('input[type="search"]'); if (s) s.value = state.query; paint(); }
    return true;
  }
  // The name-based pair suggestion (net-intent.js) that holds `net`, if any: offered, never applied by itself.
  function suggestionFor(project, board, net) {
    if (!net || !board) return null;
    let M; try { M = S().model(project, board); } catch { return null; }
    return suggestions(project, board, M).find(g => g.positive === net || g.negative === net) || null;
  }

  return Object.freeze({rows, suggestions, suggestionFor, actions, headless, toggle: (h, show) => { if (h) install(h); return toggle(show); }, show, install, isOpen: () => !!panel && !panel.hidden});
})();
