"use strict";
// The app-bar, slash and command shortcuts share one dialog and one AtriumSearchIndex.
// An opening captures the placement, editor surface and selection before taking focus.
// Prefixes >, @ and : select commands, objects and coordinates in either keyboard mode.
// Project and library postings build in idle slices after the first open. Local rows
// render from the current index immediately. Late sources append within that query.
// Recent choices use stable keys and the existing local search.usage preference.
globalThis.AtriumPalette = (() => {
  const C = globalThis.AtriumNavCommon;
  const enhanced = () => globalThis.AtriumLabs?.notebookEnabled() === true;
  const t = globalThis.AtriumI18n?.define({
    "palette.calculating":"Calculating…",
    "palette.no_answer":"No calculation result",
    "palette.answer_unavailable":"Calculation unavailable",
    "palette.copy_result":"Copy Result",
    "palette.insert_calculation":"Insert Calculation",
    "palette.apply_calculation":"Set Selected Part Value…",
    "palette.copy_name":"Copy Name",
    "palette.edit_options":"Options…",
    "palette.insert_item":"Insert {name}",
    "palette.run_item":"Run {name}",
    "palette.open_item":"Open {name}"
  });
  const RECENT_KEY = "atrium-palette-recent", RECENT_MAX = 12, LIMIT = 60;
  let calculationAvailable = false;
  // Session keys and internal actions that make no sense out of context.
  const HIDDEN = new Set(["pan-hold", "keep-routing", "prefix-cancel", "escape", "place-at-pointer", "select-at-pointer", "tool-properties", "length-key", "cursor-step", "nudge", "zoom-at", "context-menu"]);

  // ------------------------------------------------------------------ fuzzy
  // Score how well `q` (lower case, one word) matches `t` (lower case). Higher is
  // better; -1 is no match. A contiguous match beats a scattered one, and matches
  // at word starts ("pcb list" ← "pl") beat matches inside words.
  const boundary = c => c === 32 || c === 45 || c === 95 || c === 46 || c === 47 || c === 40 || c === 62 || c === 58 || c === 44;
  function wordScore(q, t) {
    if (!q) return 0;
    const at = t.indexOf(q);
    if (at >= 0) {
      const start = at === 0 || boundary(t.charCodeAt(at - 1));
      return 100 + q.length * 6 + (start ? 40 : 0) - Math.min(at, 30) + (at === 0 ? 20 : 0) + (q.length === t.length ? 30 : 0);
    }
    // Subsequence with bonuses for word starts and consecutive characters.
    let score = 0, ti = 0, run = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q.charCodeAt(qi);
      let found = -1;
      // Prefer the next word start that has this character.
      for (let k = ti; k < t.length; k++) if (t.charCodeAt(k) === c && (k === 0 || boundary(t.charCodeAt(k - 1)))) {found = k; break;}
      const next = t.indexOf(q[qi], ti);
      if (next < 0) return -1;
      if (found < 0 || (run > 0 && next === ti)) found = next;
      const start = found === 0 || boundary(t.charCodeAt(found - 1));
      run = found === ti && qi > 0 ? run + 1 : 0;
      score += 4 + (start ? 12 : 0) + run * 5 - Math.min(found - ti, 8);
      ti = found + 1;
    }
    return score;
  }
  // Every space-separated word of the query must match. Returns -1 when one does not.
  function score(query, text) {
    if (!query) return 0;
    let total = 0, from = 0;
    for (;;) {
      while (from < query.length && query.charCodeAt(from) === 32) from++;
      if (from >= query.length) break;
      let to = query.indexOf(" ", from); if (to < 0) to = query.length;
      const s = wordScore(query.slice(from, to), text);
      if (s < 0) return -1;
      total += s; from = to;
    }
    return total;
  }
  // Character positions in `text` to emphasise for `query` (display only).
  function matches(query, text) {
    const t = text.toLowerCase(), out = new Set();
    for (const w of query.toLowerCase().split(/\s+/).filter(Boolean)) {
      const at = t.indexOf(w);
      if (at >= 0) {for (let k = 0; k < w.length; k++) out.add(at + k); continue;}
      let ti = 0;
      for (const ch of w) {const k = t.indexOf(ch, ti); if (k < 0) break; out.add(k); ti = k + 1;}
    }
    return [...out].sort((a, b) => a - b);
  }
  // Text with <mark> runs for the matched characters.
  function highlighted(text, query) {
    const frag = document.createDocumentFragment(), hits = new Set(query ? matches(query, text) : []);
    let run = "", marked = false;
    const flush = () => {if (!run) return; frag.append(marked ? C.el("mark", run) : document.createTextNode(run)); run = "";};
    for (let k = 0; k < text.length; k++) {const m = hits.has(k); if (m !== marked) {flush(); marked = m;} run += text[k];}
    flush(); return frag;
  }

  if (C) Object.assign(C, {score, wordScore, matches, highlighted});

  // ------------------------------------------------------------------ parsing
  function parse(text) {
    const t = String(text ?? "");
    const c = t[0];
    if (c === ">" || c === "@" || c === ":") return {mode:c, q:t.slice(1).trim()};
    return {mode:"", q:t.trim()};
  }
  // ":12.5, 30" or ":12.5 30mil" → [x, y] in millimetres, or null.
  function parseLocation(text, unit = "mm") {
    const U = globalThis.Atrium?.units;
    const parts = String(text ?? "").trim().replace(/^:/, "").split(/\s*[,;]\s*|\s+(?=[-+\d.])/).filter(Boolean);
    if (parts.length !== 2 || !U) return null;
    const v = parts.map(p => U.parse(p, unit));
    return v.every(Number.isFinite) ? v : null;
  }

  // ------------------------------------------------------------------ vocabulary
  // Keywords per action id live in palette-words.js (lazy data, loaded when the palette opens).
  const KEYWORDS = new Proxy({}, {get: (_, k) => globalThis.AtriumPaletteWords?.[k]});
  try {
    const L = globalThis.AtriumLazy;
    L?.register?.("AtriumPaletteWords", {scripts:["editor/palette-words.js"]});
    L?.register?.("AtriumSearchData", {scripts:["search-data.js"]});
    L?.register?.("AtriumSearchIndex", {scripts:["editor/search-index.js"]});
    L?.register?.("AtriumPaletteView", {scripts:["editor/palette-view.js"], css:["editor/search.css"]});
    L?.register?.("AtriumPaletteActions", {scripts:["library/generic-parts.js","editor/palette-actions.js"]});
  } catch {}
  // ------------------------------------------------------------------ search
  // entries: [{key, label, detail, hint, kind, run, keywords?, hay?, lower?}] — hay/lower/kw are filled lazily.
  function prepare(e) {
    if (e.lower === undefined) {
      e.lower = e.label.toLowerCase(); e.hay = (e.label + " " + (e.detail || "") + " " + (e.alias || "")).toLowerCase();
      e.kw = (e.keywords || "").toLowerCase();
    }
    return e;
  }
  // Fuzzy subsequence matches that are mostly noise are dropped: a word that is not found as a run
  // of letters must average at least MIN_PER_CHAR points per character (word starts and runs score
  // high; letters scattered through a long title score near zero).
  const MIN_PER_CHAR = 9;
  function strictScore(q, text) {
    if (!text) return -1;
    let total = 0;
    for (const w of q.split(" ")) {
      if (!w) continue;
      const s = C.score(w, text);
      if (s < 0 || (text.indexOf(w) < 0 && s < w.length * MIN_PER_CHAR)) return -1;
      total += s;
    }
    return total;
  }
  function search(entries, query, {recent = [], limit = LIMIT, kinds = null} = {}) {
    const q = String(query || "").toLowerCase().trim(), rank = new Map();
    recent.forEach((k, i) => rank.set(k, recent.length - i));
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = prepare(entries[i]);
      if (kinds && !kinds.has(e.kind)) continue;
      let s;
      if (!q) s = 0;
      else {
        // Best of: the title, the action's keywords (nearly as good as the title), the detail text.
        s = strictScore(q, e.lower);
        const k = strictScore(q, e.kw);
        // A keyword phrase typed whole ("board outline", "copper pour") outranks a looser title match.
        if (k >= 0) s = Math.max(s, k * .9 + (q.length > 2 && e.kw.includes(q) ? 60 : 0));
        if (s < 0) {const h = strictScore(q, e.hay); s = h < 0 ? -1 : h * .6;}
        if (s < 0) continue;
      }
      const r = rank.get(e.key) || 0;
      s += r ? 400 + r * 10 : 0;
      s += e.boost || 0;
      out.push({e, s, i});
    }
    out.sort((a, b) => b.s - a.s || a.i - b.i);
    const total = out.length;
    const list = out.slice(0, limit).map(x => x.e);
    list.total = total;
    return list;
  }

  // ------------------------------------------------------------------ objects (@)
  // Designators, nets and (once a dash is typed) pads, current document first.
  function objectEntries(project, defs, currentId, query = "") {
    const out = [], cur = project.documents.find(d => d.id === currentId);
    const docs = cur ? [cur, ...project.documents.filter(d => d !== cur)] : project.documents;
    const wantPads = /-/.test(query), seenNets = new Set();
    for (const d of docs) {
      const kind = d.kind === "pcb" ? "Board" : "Schematic", here = d === cur;
      const nets = new Set();
      for (const i of d.items) {
        if (i.kind === "part" && i.ref) {
          out.push({key:"obj:" + d.id + ":" + i.id, kind:"object", label:i.ref, detail:(i.value ? i.value + " · " : "") + kind + " · " + d.name, boost:here ? 30 : 0,
            target:{type:"part", docId:d.id, id:i.id}});
          if (wantPads && d.kind === "pcb") for (const p of defs.get(i.def)?.footprint?.pads || []) if (p.number != null)
            out.push({key:"pad:" + d.id + ":" + i.id + ":" + p.number, kind:"object", label:i.ref + "-" + p.number, detail:"Pad · " + ((i.pinNets?.[p.number] ?? p.net) || "no net") + " · " + d.name, boost:here ? 25 : 0,
              target:{type:"pad", docId:d.id, id:i.id, pad:String(p.number)}});
          if (i.pinNets) for (const n of Object.values(i.pinNets)) if (n) nets.add(n);
        } else if (i.net) nets.add(i.net);
        else if (i.kind === "netlabel" && i.text) nets.add(i.text);
      }
      if (d.kind === "schematic") {try {for (const n of globalThis.Atrium.connectivity(d, defs).nets) nets.add(n.name);} catch {}}
      for (const n of [...nets].sort()) {
        if (seenNets.has(n)) continue; seenNets.add(n);
        out.push({key:"net:" + n, kind:"object", label:n, detail:"Net · " + kind + " · " + d.name, boost:here ? 20 : 0, target:{type:"net", docId:d.id, net:n}});
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ UI
  let lastSearch = null;
  let host = null, dialog = null, input = null, active = 0, results = [], previous = null;
  let nextChord = null;
  let recent = [];
  try {recent = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) || "[]").filter(k => typeof k === "string").slice(0, RECENT_MAX);} catch {}
  function remember(key) {
    recent = [key, ...recent.filter(k => k !== key)].slice(0, RECENT_MAX);
    try {globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(recent));} catch {}
    const u = {...usageMap()}, old = u[key];
    usageCache = u;
    u[key] = [(old?.[0] || 0) + 1, Date.now()];
    const keys = Object.keys(u);
    if (keys.length > USAGE_MAX) for (const k of keys.sort((a, b) => u[a][1] - u[b][1]).slice(0, keys.length - USAGE_MAX)) delete u[k];
    try {
      const P = globalThis.AtriumPrefs || globalThis.AtriumPref;
      if (P?.set) P.set(USAGE_PREF, u);
      else globalThis.localStorage?.setItem(USAGE_PREF, JSON.stringify(u));
    } catch {}
  }
  // Frequency and recency of use per result key: {key: [count, last used ms]}, local to this
  // user (AtriumPrefs, or localStorage before it loads); nothing leaves the machine.
  const USAGE_PREF = "search.usage", USAGE_MAX = 300, DAY = 864e5;
  let usageCache = null;
  function usageMap() {
    if (usageCache) return usageCache;
    let u = null;
    try {u = (globalThis.AtriumPref || globalThis.AtriumPrefs)?.get?.(USAGE_PREF);} catch {}
    if (!u || typeof u !== "object") try {u = JSON.parse(globalThis.localStorage?.getItem(USAGE_PREF) || "null");} catch {}
    usageCache = u && typeof u === "object" ? u : {};
    return usageCache;
  }
  function usageBonus(key, at = Date.now()) {
    const u = usageMap()[key];
    if (!Array.isArray(u)) return 0;
    const age = (at - (u[1] || 0)) / DAY;
    return Math.min(50, 12 * Math.log2(1 + (u[0] || 0))) + 30 * Math.pow(.5, Math.max(0, age) / 3);
  }
  let commandCache = null;
  globalThis.AtriumKeymap?.onChange?.(() => {
    commandCache = null; legacyDirty = true;
    if (session && IX) queueMicrotask(() => {if (session && query) {refreshSources(); update(false);}});
  });
  function kind() {return host?.doc()?.kind || globalThis.document?.body?.dataset.kind || "schematic";}
  // Menu path of each data-action in the menu bar: "Tools › Design Rule Check…".
  function menuActions() {
    const out = new Map();
    if (typeof document === "undefined") return out;
    const submenuNames = new Map();
    for (const menu of document.querySelectorAll(".menubar .work-menu, .panels-menu")) {
      const name = menu.querySelector("summary")?.textContent.trim() || "";
      for (const b of menu.querySelectorAll(".menu-items [data-action]")) {
        const a = b.dataset.action;
        if (!enhanced() && (globalThis.AtriumLabs?.allowsAction?.(a) === false || globalThis.AtriumKeymap?.command(a)?.notebook || b.hasAttribute("data-notebook-action"))) continue;
        const hidden = b.hidden || b.disabled || !!b.closest(".submenu[hidden]");
        if (out.has(a) && !out.get(a).hidden) continue;
        const icon = b.querySelector("svg use")?.getAttribute("href")?.replace(/^#/, "");
        // Submenu items read "Polygon Pours: Repour All", their path "Tools › Polygon Pours".
        const subs = [];
        for (let n = b.parentElement?.closest(".submenu"); n && menu.contains(n); n = n.parentElement?.closest(".submenu")) {
          if (!submenuNames.has(n)) submenuNames.set(n,n.querySelector(":scope > .submenu-trigger")?.textContent.trim() || "");
          subs.unshift(submenuNames.get(n));
        }
        const own = C.menuLabel(b);
        // Place › Power Port › GND/VCC…: the action is "Power Port"; each net gets its own entry.
        if (b.dataset.powerNet != null && subs.length) {out.set(a, {label:subs.at(-1), own:subs.at(-1), path:[name, ...subs.slice(0, -1)].join(" › "), node:b, hidden, icon, category:menu.dataset.menu}); continue;}
        // "Compare › Compare…" reads "Compare…", not "Compare: Compare…".
        const sub = subs.at(-1) || "", pre = sub && !own.toLowerCase().startsWith(sub.toLowerCase()) ? sub + ": " : "";
        out.set(a, {label:pre + own, own, path:[name, ...subs].join(" › "), node:b, hidden, icon, category:menu.dataset.menu});
      }
    }
    return out;
  }
  function commandEntries() {
    const k = kind();
    if (commandCache && commandCache.kind === k) return commandCache.list;
    const KM = globalThis.AtriumKeymap, menus = menuActions(), out = [], seen = new Set();
    const state = {kind:k, tool:"select", interactive:false, selected:true, selectionCount:1, canvas:true, __assume:true};
    for (const cmd of KM?.commands?.() || []) {
      if (/^(?:power|menu):/.test(cmd.id) || globalThis.AtriumExtensionPalette?.shortcutId?.(cmd.id) === cmd.id || HIDDEN.has(cmd.id) || HIDDEN.has(cmd.action) || cmd.category === "Cursor") continue;
      if (cmd.whenTest && !cmd.whenTest(state, true)) continue;
      const m = menus.get(cmd.action);
      // Keys that only act inside a routing or tuning session stay out of the palette.
      const recs = KM.table?.().byCommand.get(cmd.id) || [];
      if (!m && recs.length && recs.every(r => /\b(routing|tuning)\b/.test(r.when) && !/!\s*(routing|tuning)\b/.test(r.when))) continue;
      if (m?.hidden && m.node?.dataset.scope && m.node.dataset.scope !== k) continue;
      // The menu's wording (Title Case, "…" for dialogs) when the command is on a menu.
      const title = m && !m.hidden ? m.label : cmd.builtin ? titleCase(cmd.titles?.[k] || cmd.title) : cmd.titles?.[k] || cmd.title;
      seen.add(cmd.action); seen.add(cmd.id);
      out.push({key:"cmd:" + cmd.id, kind:"command", label:title, detail:m ? m.path + " › " + m.own : cmd.category, alias:cmd.id + " " + cmd.category,
        previewText:m && (m.node.dataset.tooltipLabel || m.node.title), icon:m?.icon, category:m?.category || cmd.category, action:cmd.action, keywords:KEYWORDS[cmd.action] || KEYWORDS[cmd.id] || "", hint:KM.hintKey(cmd.id, k), run:() => runCommand(cmd)});
    }
    for (const [a, m] of menus) {
      if (seen.has(a) || m.hidden) continue;
      out.push({key:"menu:" + a, kind:"command", label:m.label, detail:m.path, alias:a, previewText:m.node.dataset.tooltipLabel || m.node.title, icon:m.icon, category:m.category, action:a, keywords:KEYWORDS[a] || "", hint:KM?.menuHintKey?.(m.node,k) || "", run:() => m.node.click()});
    }
    // Place › Power Port › GND, VCC…: one entry per net, so "vcc" or "gnd" finds them.
    for (const n of k === "schematic" && typeof document !== "undefined" ? document.querySelectorAll('.menubar [data-power-net]:not([data-power-net=""])') : []) {
      const net = n.dataset.powerNet;
      out.push({key:"power:" + net, kind:"command", label:"Place Power Port: " + net, detail:"Place › Power Port › " + net, alias:"sch-power power port " + net,
        category:"place", icon:"label", keywords:KEYWORDS["sch-power"], hint:KM?.menuHintKey?.(n,k) || "", run:() => n.click()});
    }
    commandCache = {kind:k, list:out};
    return out;
  }
  // "Toggle visible grid" -> "Toggle Visible Grid"; short words stay lower case, mm/mil and (…) stay as written.
  const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "with", "within", "per", "via"]);
  function titleCase(text) {
    let depth = 0, first = true;
    return String(text).replace(/\(|\)|[A-Za-z][\w'’]*/g, w => {
      if (w === "(") {depth++; return w;} if (w === ")") {depth = Math.max(0, depth - 1); return w;}
      const keep = depth || /^(mm|mils?|ps|x\d+|[a-z]+[A-Z]\w*)$/.test(w) || (!first && SMALL.has(w));
      first = false;
      return keep ? w : w[0].toUpperCase() + w.slice(1);
    });
  }
  function runCommand(cmd) {
    if (cmd.run) cmd.run(cmd.param);
    else if (host) host.executeKey(cmd.action, cmd.param);
    else globalThis.dispatchEvent?.(new CustomEvent("atrium-command", {detail:cmd.action}));
  }
  function settingEntries() {
    const out = [], T = globalThis.AtriumTheme, d = host?.doc(), U = globalThis.Atrium?.units;
    const add = (key, label, run, detail = "Settings") => out.push({key:"set:" + key, kind:"setting", label, detail, run});
    if (T) {
      for (const id of T.PRESET_IDS) add("theme-" + id, "Preferences: Color Theme: " + T.PRESETS[id].label, () => T.setPreset(id));
      add("theme-follow", "Preferences: Color Theme: Follow System", () => T.set({followSystem:true}));
      add("theme-open", "Preferences: Appearance…", () => T.open());
    }
    if (host) {
      const unit = host.units();
      add("units-mm", "Preferences: Units: Millimetres" + (unit === "mm" ? " (current)" : ""), () => {if (host.units() !== "mm") host.act("toggle-units");});
      add("units-mil", "Preferences: Units: Mils" + (unit === "mil" ? " (current)" : ""), () => {if (host.units() !== "mil") host.act("toggle-units");});
      if (d && U) for (const g of U.presets(unit, d.kind)) {
        const text = U.format(g, unit);
        add("grid-" + d.kind + "-" + text, "Preferences: Snap Grid: " + text + (Math.abs(g - d.grid) < 1e-9 ? " (current)" : ""), () => host.edit(() => {host.doc().grid = g;}), "Settings · " + d.name);
      }
    }
    return out;
  }
  function documentEntries() {
    if (!host) return [];
    const cur = host.currentId();
    return host.project().documents.map(d => ({key:"doc:" + d.id, kind:"document", label:d.name, detail:(d.kind === "pcb" ? "Board layout" : d.kind === "drawing" ? "Drawing" : "Schematic") + (d.id === cur ? " · open" : "") + (d.sourceName ? " · " + d.sourceName : ""),
      run:() => host.selectDocument(d.id)}));
  }
  // Recent projects: the native host's recent files (AtriumHost.recentFiles(), a cached list of
  // {name, path, openedAt}; openRecent(entry) -> Promise<File[]> opened like File › Open) and the
  // projects autosaved in this browser (AtriumAutosave.recent(), IndexedDB), which reopen from
  // their newest snapshot.
  function fileEntries() {
    const H = globalThis.AtriumHost, files = (typeof H?.recentFiles === "function" && H.recentFiles()) || [];
    const out = files.slice(0, 20).map(f => ({key:"file:" + (f.path || f), kind:"file", label:String(f.name || f.path || f).split(/[\\/]/).pop(), detail:"Recent file · " + (f.path || f),
      run:() => Promise.resolve(H?.openRecent?.(f,{activate:true})).then(list => { if (list?.length) host?.openFiles?.(list); }).catch(e => host?.info?.(e.message))}));
    const seen = new Set(files.map(f => f.path || f)), S = globalThis.AtriumAutosave;
    for (const r of (S?.recent?.() || []).slice(0, 20)) {
      if (r.path && seen.has(r.path)) continue;
      out.push({key:"recent:" + r.slot, kind:"file", label:r.name, detail:"Recent project · autosaved " + S.fmtTime(r.updated) + " · " + S.fmtSize(r.size) + (r.path ? " · " + r.path : "") + (r.dirty ? " · unsaved changes" : ""),
        run:() => S.openRecent(r.slot).catch(e => host?.info?.(e.message))});
    }
    return out;
  }
  async function gotoObject(t, guard) {
    if (t.type === "doc") return Promise.resolve(host.selectDocument(t.docId)).then(() => {
      if (host.currentId() === t.docId) globalThis.AtriumShell?.focusEditor();
    });
    const p = host.project(), defs = host.defs();
    if (t.type === "library") return placeLibrary(t.id);
    if (t.type === "net" && !t.docId) {
      // A net on several documents: the current one when it has the net, else the first.
      const docs = IX?.state.netDocs.get(t.net), cur = host.currentId();
      t = {...t, docId:docs?.has(cur) || !docs?.size ? cur : [...docs][0]};
    }
    const doc = p.documents.find(d => d.id === t.docId);
    if (!doc) return;
    if (t.type === "netclass") {
      if (t.docId !== host.currentId()) host.selectDocument(t.docId);
      const nets = t.nets || [], found = globalThis.AtriumCrossProbe?.netObjectsBatch(doc,defs,nets), ids = [];
      let box = null;
      for (const n of nets) {
        const row = found?.get(n);
        if (!row) continue;
        for (const id of row.ids) ids.push(id);
        box = C.union(box,row.box);
      }
      if (ids.length) host.select(ids);
      if (box) host.zoomTo(box);
      globalThis.AtriumShell?.focusEditor();
      host.info("Net class " + (t.nets?.length ? (t.nets.length + " nets · " + ids.length + " objects") : "with no nets"));
      return;
    }
    if (host.project() !== p || guard && !guard()) return;
    let ui = globalThis.AtriumIntelUI;
    if (!ui) {
      const lazy = globalThis.AtriumLazy;
      if (lazy?.register && !lazy.modules().includes("AtriumIntelUI"))
        lazy.register("AtriumIntelUI", {scripts:["editor/workspace-tools.js"], css:["editor/workspace-tools.css"]});
      ui = await lazy?.need?.("AtriumIntelUI");
    }
    if (!ui || host.project() !== p || guard && !guard()) return;
    return ui.probe({type:t.type, docId:t.docId, id:t.id, ownerId:t.ownerId, pad:t.pad, padIndex:t.padIndex,
      padId:t.padId, instanceId:t.instanceId, net:t.net}, {
      focus:t.type !== "net", activateOccurrence:!!guard, current:() => host.project() === p && (guard?.() ?? true),
      order:["highlight", "select", "zoom", "focus"],
      status(hit) {
        host.info(t.type === "net" ? "Net " + hit.net + (hit.ids.length ? " · " + hit.ids.length + " objects" : "") :
          hit.label + (t.pad != null ? "." + t.pad : "") + " on " + doc.name);
      }});
  }
  // A library part: start placing it (the editor's placeDef), else show it in the Library panel.
  function placeLibrary(id) {
    const rec = IX?.get("lib:" + id);
    const def = rec?.def || host.defs().get(id) || globalThis.AtriumCatalogue?.get?.(id, {project:host.project()});
    if (def && host.placeDef) {host.placeDef(def); return;}
    host.act?.("library-panel");
    host.info?.(def ? "Library: " + (def.name || id) : "Part " + id + " is not in the library.");
  }
  function locationEntries(q, surface = null) {
    const unit = surface?.units || host?.units() || "mm", p = parseLocation(q, unit);
    if (!p) return [{key:"loc:?", kind:"location", label:q ? "Enter X, Y (for example 10, 20 or 400mil, 250mil)" : "Type a coordinate: X, Y in " + unit, detail:"Go to location", run:null}];
    const U = globalThis.Atrium.units;
    return [{key:"loc:" + p.join(","), kind:"location", label:"Go to X " + U.format(p[0], unit) + ", Y " + U.format(p[1], unit), detail:"Centre the view on this point" + (!surface && host?.doc()?.origin ? " (board origin)" : ""),
      run:() => {
        if (surface) {surface.centerOn?.(p); return;}
        const d = host.doc(), world = d.kind === "pcb" && globalThis.AtriumBoardShape?.fromUser ? AtriumBoardShape.fromUser(d, p) : p;
        host.centerOn(world); host.info("Centred on " + U.format(p[0], unit) + ", " + U.format(p[1], unit));
      }}];
  }
  function sources(mode, q) {
    if (mode === ">") return commandEntries();
    if (mode === "@") return host ? objectEntries(host.project(), host.defs(), host.currentId(), q).map(e => (e.run = () => gotoObject(e.target), e)) : [];
    if (mode === ":") return locationEntries(q);
    return [...commandEntries(), ...documentEntries(), ...fileEntries(), ...settingEntries()];
  }

  // ------------------------------------------------------------------ one index and provider registry
  let IX = null, indexing = null, indexChanges = 0, indexedAt = -1, indexStats = null;
  let session = null, view = null, query = null, refreshFrame = 0, legacyDirty = true;
  const providers = new Map(), streamGroups = new Set();
  let scope = "", scopedProvider = null, inline = new Map(), usage = new Map(), lastPartial = 0;
  function withAliases(e) {
    const aliases = session?.enhanced && globalThis.AtriumPalettePersonal?.aliases?.(e.key);
    return aliases?.length ? {...e,aliases,keywords:[...aliases,e.keywords || ""].join(" ")} : e;
  }
  const KINDS = {">":new Set(["command"]), "@":new Set(["component","net","netclass","port","pin","document"]),
    find:new Set(["component","net","port","pin","notebook"]), files:new Set(["document","file"])};
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const section = r => r.kind === "insert" || r.kind === "library" ? "Insert" : r.kind === "command" || r.kind === "setting" ? "Commands" : "Jumps";
  const sourceNames = {library:"Library",component:"Components",pin:"Pins and pads",net:"Nets",netclass:"Nets",
    port:"Ports and labels",document:"Documents",file:"Recent files",setting:"Settings",help:"Help",notebook:"Notebook",clipboard:"Clipboard"};
  function displayGroup(r, sources = false) {
    const entry = r.e || r;
    if (entry.provider === "extensions") return "ext\u0000" + (entry.source || "Extensions");
    return sources && sourceNames[r.kind] || section(r);
  }
  const legacyGroup = {command:"Commands", document:"Documents", component:"Components", pin:"Components", net:"Nets", netclass:"Nets", port:"Ports and labels", library:"Library", file:"Files", setting:"Settings", help:"Help"};
  function registerProvider(id, provider) {
    if (!id || !provider) throw Error("A palette provider needs an ID and a source.");
    const record = typeof provider === "function" ? {entries:provider} : provider;
    providers.set(id, record);
    invalidateProvider(id);
    return () => {
      if (providers.get(id) !== record) return;
      providers.delete(id); invalidateProvider(id);
    };
  }
  function invalidateProvider(id) {
    if (!IX || !session?.enhanced) return;
    if (id === "personal") refreshSources(); else providerEntries(id);
    for (const name of streamGroups) {
      const entries = IX.source(name);
      const current = entries.filter(e => e.provider !== id || e.isCurrent?.() !== false);
      if (current.length !== entries.length) IX.setGroup(name,current);
      if (!current.length) streamGroups.delete(name);
    }
    collectInline(); scheduleRefresh();
  }
  function providerEntries(id) {
    const p = providers.get(id);
    let entries = [];
    try {entries = p?.entries?.(session) || [];} catch (error) {host?.info?.(error.message);}
    const list = entries.filter(e => {
      if (!e || typeof e.key !== "string" || typeof e.label !== "string") return false;
      const old = IX.get(e.key);
      return !old || old.e?.provider === id;
    }).map(e => withAliases({
      ...e, provider:id, kind:e.kind || "insert", keywords:[e.keywords,...e.inline || []].filter(Boolean).join(" "),
      boost:id === "extensions" ? 0 : e.boost || 0
    }));
    IX.setGroup("provider:" + id, list);
  }
  function snapshot(raw) {
    const A = raw.enhanced && globalThis.AtriumPaletteActions, surface = raw.enhanced ? raw.surface || A?.surface?.(raw.target) : null;
    const d = host.doc(), v = host.view?.(), c = host.canvas?.();
    const point = raw.point || surface?.point?.() || v?.screenToWorld?.([(c?.clientWidth || 0)/2, (c?.clientHeight || 0)/2]) || [0,0];
    const selection = Object.freeze([...(raw.selection || [])]);
    const context = {host, surface, enhanced:raw.enhanced, labsSignal:raw.enhanced ? globalThis.AtriumLabs.notebookSignal() : undefined, instanceId:raw.instanceId, docId:raw.docId || host.currentId(), kind:surface?.kind || d.kind,
      point:Object.freeze([...point]), pointerType:raw.pointerType, selection, selectedKind:selection.length ? d.items?.find(i => i.id === selection[0])?.kind : null,
      tool:raw.tool, mode:!dialog ? "insert" : dialog.dataset.mode === "command" && !commandScope() ? "search" : dialog.dataset.mode, source:raw.source || raw.entrance};
    return Object.freeze({...context,...A?.context?.(host, context)});
  }
  // The insert rows of these groups, for a flyout the notebook provides to the Active Bar
  // (AtriumWidgetCatalogue.toolGroups): the "/" palette's own rows and runs, with the palette's
  // request at the point Insert at pointer uses from the keyboard (the canvas centre).
  function toolGroup(groups) {
    if (!host?.doc?.() || !enhanced()) return [];
    const context = snapshot({enhanced:true, pointerType:"keyboard", source:"active-bar"}), out = [];
    for (const p of providers.values()) {
      let list = [];
      try {list = p.entries?.(context) || [];} catch (error) {host?.info?.(error.message);}
      for (const e of list) if ((e?.kind || "insert") === "insert" && groups.includes(e.group) && typeof e.run === "function")
        out.push({id:e.key, label:e.label, icon:e.icon, run:() => e.run({context, values:{}, argument:"", signal:context.labsSignal})});
    }
    return out;
  }
  function refreshSources() {
    if (!IX || !session) return;
    const surface = session.surface;
    const commands = surface ? surface.commands?.() || [] : commandEntries();
    IX.setGroup("commands", session.enhanced && globalThis.AtriumPalettePersonal ? commands.map(withAliases) : commands);
    IX.setGroup("surface", surface?.objects?.() || []);
    IX.setGroup("files", surface ? [] : fileEntries());
    IX.setGroup("settings", surface ? [] : settingEntries());
    if (session.enhanced) for (const id of providers.keys()) providerEntries(id);
  }
  function startIndex() {
    if (!host || IX || !globalThis.AtriumSearchIndex) return;
    IX = AtriumSearchIndex.create();
    if (!session) IX.setGroup("commands", commandEntries());
    staticSources();
    requestIndex();
  }
  function syncProject() {
    return IX.sync(host.project(),host.defs(),{journal:globalThis.AtriumUndoStore,notebook:enhanced(),documentRefs:() => host.documentRefs?.()});
  }
  let loadingFamilies;
  function requestIndex() {
    if (!IX || !dialog?.open || query?.designQuery || indexedAt === indexChanges || indexing || globalThis.AtriumPower?.visible?.() === false) return;
    if (enhanced() && host.project()?.componentFamilies?.length && !globalThis.AtriumComponentFamilies && loadingFamilies !== null) {
      const resume = () => {loadingFamilies = null; indexChanges++; requestIndex();};
      loadingFamilies ??= globalThis.AtriumLazy?.need("AtriumComponentFamilies").then(resume,resume);
      if (loadingFamilies) return;
    }
    const at = indexChanges, t = now();
    indexing = AtriumSearchIndex.runIdle(syncProject(), stats => {
      indexedAt = at; indexing = null; indexStats = {...stats, ms:now() - t};
      refreshIndexedResults();
      if (indexChanges !== at) requestIndex();
    },() => {
      if (query?.text && now()-lastPartial > 100) {lastPartial = now(); refreshIndexedResults();}
    });
  }
  // Explicit diagnostic/headless drain. Interactive searches always read the current postings.
  function readyIndex() {
    if (!IX) return false;
    if (indexing) indexing.finish();
    if (indexedAt !== indexChanges) {
      const t = now();
      const stats = AtriumSearchIndex.runNow(syncProject());
      indexedAt = indexChanges; indexStats = {...stats, ms:now() - t};
    }
    return true;
  }
  function stopIndex() {indexing?.cancel(); indexing = null;}
  const notebookHelp = new Set(["palette-contributions","declarative-screens","streaming-search","pure-calculation-functions","sheet-widgets"]);
  function staticSources() {
    const D = globalThis.AtriumSearchData;
    if (!D || !IX) return;
    const showNotebook=enhanced();
    IX.setGroup("prefs", D.prefs.filter(row=>showNotebook || row[3]!=="search").map(([key,label,help,page,title]) => ({key:"pref:" + key, kind:"setting", label, detail:"Preferences › " + title + (help ? " · " + help : ""), alias:key.replace(/[.]/g," "), run:() => openPref(page,key)})));
    IX.setGroup("help", D.help.filter(([file,,anchor])=>showNotebook || !["docs/calculation-helpers.md","docs/calculations.md"].includes(file) && !(file==="docs/extension-api.md" && notebookHelp.has(anchor))).map(([file,heading,anchor,title]) => ({key:"help:" + file + "#" + anchor, kind:"help", label:heading, detail:"Help › " + title, run:() => openHelp(file,anchor)})));
  }
  function openPref(page, key) {
    Promise.resolve(globalThis.AtriumLazy?.need?.("AtriumPrefs")).then(() => {
      globalThis.AtriumPrefs?.open?.(page);
      const n = document.getElementById("prf-" + key.replace(/\W/g, "-"));
      n?.scrollIntoView?.({block:"center"}); n?.focus?.();
    }).catch(e => host?.info?.(e.message));
  }
  function openHelp(file, anchor) {
    const url = "../" + file + (anchor ? "#" + anchor : "");
    try {if (globalThis.AtriumHost?.openURL) return AtriumHost.openURL(new URL(url, location.href).href);} catch {}
    globalThis.open?.(url, "_blank", "noopener");
  }
  function definition(rec) {
    return rec.def?.stub && rec.library ? globalThis.AtriumLibrarySources?.load(rec.library, rec.def.id) : rec.def;
  }
  function entryOf(rec) {
    if (rec.e) return rec.e;
    if (rec.entry) return rec.entry;
    const e = {key:rec.key, kind:rec.kind, label:rec.label, detail:rec.detail, target:rec.target};
    if (rec.kind === "library") {
      if (rec.family) e.family = rec.family;
      e.preview = async req => {
        const def = await definition(rec);
        return req.signal?.aborted || !def ? null : {kind:req.context.kind === "pcb" ? "footprint" : "symbol",def};
      };
      e.run = async req => {
        const def = await definition(rec);
        if (!def || req.signal?.aborted || req.context.labsSignal?.aborted || req.context.docId !== host.currentId()) return;
        return req.context.enhanced && globalThis.AtriumPaletteActions?.placeLibrary ? AtriumPaletteActions.placeLibrary(def,{...req,library:rec.library}) : placeLibrary(def.id);
      };
    } else e.run = () => gotoObject(rec.target);
    return rec.entry = e;
  }
  const requestOf = (e, values = {}) => ({context:session,scope,providerId:scopedProvider,library:e?.kind === "library" ? IX?.get(e.key)?.library : null,query:query?.text || "",queryId:query?.id,argument:e?.argument || "",values,signal:query?.controller.signal});
  function recordAllowed(r, ctx, notebook) {
    if (r.e?.stream || r.e?.ephemeral) return false;
    if (!notebook && (r.kind === "notebook" || r.e?.provider)) return false;
    if (!ctx) return true;
    if (ctx.surface && !r.e) return false;
    if (ctx.surface && ["setting","help","file"].includes(r.kind) && !r.e?.provider) return false;
    if (r.kind !== "library") return true;
    return ctx.kind === "pcb" ? !!r.def?.footprint || !!r.def?.stub?.footprint : ctx.kind === "schematic" && (!!r.def?.symbol || !!r.def?.stub?.symbol);
  }
  function groupEntries(rows, counts, total) {
    const out = [], groups = [];
    for (const [name,list] of rows) {
      if (!list.length) continue;
      const external = name.startsWith("ext\u0000");
      groups.push({name:external ? name.slice(4) : name,start:out.length,count:list.length,total:counts?.get(name) || list.length,
        ...(external ? {remote:true,source:"extensions"} : {})});
      out.push(...list);
    }
    return Object.assign(out,{groups,total:Math.max(out.length,total || 0)});
  }
  function arrangeCommandMatches(matches, mode, classic) {
    const source = matches.groups.length ? matches.groups : classic && (!mode || mode === ">") ?
      [{name:mode === ">" ? "Commands" : "",start:0,count:matches.length}] : [];
    if (!source.some(group => !group.remote && (!group.name || group.name === "Commands"))) return matches;
    const ordered = [], groups = [];
    for (const group of source) {
      const rows = matches.slice(group.start, group.start + group.count);
      if (group.remote || group.name && group.name !== "Commands") {
        groups.push({...group,start:ordered.length}); ordered.push(...rows);
        continue;
      }
      const sections = new Map();
      for (const row of rows) {
        const heading = row.kind === "command" && row.category && !row.provider ? row.detail?.split(" › ",1)[0] || "" : "";
        if (!sections.has(heading)) sections.set(heading,[]);
        sections.get(heading).push(row);
      }
      // Preserve the first occurrence of each category and the score order inside it.
      for (const [heading, entries] of sections) {
        groups.push({...group,heading,start:ordered.length,count:entries.length,total:entries.length});
        ordered.push(...entries);
      }
    }
    return Object.assign(ordered,{groups,total:matches.total,ms:matches.ms});
  }
  const netCommands = new Set(["cmd:route","cmd:length","cmd:tune-length","cmd:net-class","cmd:net-properties"]);
  function loadCatalogueForQuery() {
    const captured = query;
    if (!globalThis.AtriumLazy || captured.catalogue === "failed") return false;
    if (captured.catalogue !== "loading") {
      captured.catalogue = "loading";
      const refresh = status => {
        if (query !== captured || captured.controller.signal.aborted) return;
        captured.catalogue = status;
        update(false);
      };
      AtriumLazy.need("AtriumCatalogue").then(() => refresh("ready"), () => refresh("failed"));
    }
    return true;
  }
  function ranked(mode, raw, ctx = null, loadCatalogue = false) {
    const t = now();
    if (mode === ":") {
      const list = locationEntries(raw,ctx?.surface);
      return groupEntries([["Jumps",list]]);
    }
    const prefix = (ctx ? raw.replace(/^\//,"") : raw).trim(), firstSpace = prefix.search(/\s/);
    const token = (firstSpace < 0 ? prefix : prefix.slice(0,firstSpace)).toLowerCase();
    let text = prefix, inlineKey, arg = "";
    if (ctx && !mode && inline.has(token)) {
      inlineKey = inline.get(token); text = token; arg = firstSpace < 0 ? "" : prefix.slice(firstSpace).trimStart();
    }
    const qualified = !scope && !ctx?.surface && (!mode || mode === "@") && /^([^\s.:\-]+)[.:\-](\S*)$/.exec(prefix);
    const pinRef = qualified && IX.byLabel(qualified[1]).some(r => r.kind === "component") && AtriumSearchIndex.norm(qualified[1]);
    const pin = pinRef && AtriumSearchIndex.norm(qualified[2]);
    if (pinRef) text = [pinRef,pin].filter(Boolean).join(" ");
    const narrow = !mode && !scope ? entryScope() : "";
    const kinds = pinRef ? new Set(["pin"]) : KINDS[mode] || (scope && scope !== "provider" ? new Set([scope]) : KINDS[narrow] || null);
    const bySource = !!ctx && ctx.mode !== "insert" && !mode && !!prefix;
    const localGroup = ctx ? r => displayGroup(r,bySource) : r => legacyGroup[r.kind] || section(r);
    let facet = null;
    if (!mode && /(?:^|\s)(?:[a-z]+:\S|(?:pins|pads|height)[<>=])/i.test(text)) {
      const terms = text.split(/\s+/), tests = terms.filter(w => /[:<>=]/.test(w));
      if (globalThis.AtriumCatalogue) {facet = tests.join(" "); text = terms.filter(w => !tests.includes(w)).join(" ");}
      else if (loadCatalogue && loadCatalogueForQuery()) return groupEntries([]);
    }
    const usageBoost = !ctx ? usageBonus : ctx.net ? key => (usage.get(key) || 0) + (netCommands.has(key) ? 75 : 0) :
      usage.size ? key => usage.get(key) || 0 : null;
    const exactText = ctx && !mode ? AtriumSearchIndex.norm(text) : "";
    const exactKind = ctx?.mode === "insert" ? "Insert" : ctx?.mode === "command" ? "Commands" : null;
    const notebook = enhanced();
    const libraryView = !facet && scope !== "provider" && !ctx?.surface ?
      !ctx ? 3 : ctx.kind === "pcb" ? 2 : ctx.kind === "schematic" ? 1 : 0 : 0;
    // Indexed project parts have no provider, document or command-context boost.
    // Give the index their fixed group and the exact-title and usage boosts directly.
    const libraryRanking = ctx && libraryView && (!kinds || kinds.has("library")) && indexedAt === indexChanges ?
      {group:bySource ? "Library" : "Insert",exact:exactKind === "Insert" ? exactText : null,usage} : null;
    const hits = IX.search(text,{kinds,families:notebook,usage:usageBoost,currentDoc:ctx?.docId || host.currentId(),limit:mode ? LIMIT : 24,
      libraryView,libraryRanking,
      group:localGroup,bonus:r => pinRef && (r.pinNumber === pin || r.pinName === pin) ? 500 : exactKind && r.ln === exactText && section(r) === exactKind ? 35 : 0,
      filter:r => scope !== "provider" && (!pinRef || r.pinRef === pinRef && (r.pinNumber.startsWith(pin) || r.pinName.startsWith(pin))) && recordAllowed(r,ctx,notebook) && (!facet || r.kind === "library" && AtriumCatalogue.matches(r.def,facet)),
      browse:!text,recent:ctx ? usage.keys() : Object.keys(usageMap()).concat(recent)});
    const rows = [], seen = new Map();
    for (const h of hits) {
      let e = entryOf(h.rec);
      const duplicate = h.rec.kind === "port" ? h.rec.ln + "\u0001" + h.rec.docId : e.kind === "command" ? "command:" + e.label + "\u0001" + e.detail : null;
      if (duplicate && seen.has(duplicate)) {seen.get(duplicate).n++; continue;}
      let s = h.score;
      if (e.key === inlineKey) {
        e = {...e,argument:arg};
        if (e.describe) e = {...e,...e.describe({...requestOf(e),context:ctx,argument:arg})};
        s += 10000;
      }
      const row = {e,s,n:1};
      if (duplicate) seen.set(duplicate,row);
      rows.push(row);
    }
    for (const r of rows) if (r.n > 1 && r.e.kind === "port") r.e = {...r.e,detail:r.e.detail + " · " + r.n + " on this sheet"};
    const preferred = e => !ctx || prefix || mode ? 0 : ctx.mode === "command" ? +(e.kind === "command") : ctx.mode === "insert" ? +(section(e) === "Insert") : 0;
    rows.sort((a,b) => Number(a.e.provider === "extensions") - Number(b.e.provider === "extensions") || preferred(b.e) - preferred(a.e) || b.s - a.s || a.e.label.length - b.e.label.length || (a.e.key < b.e.key ? -1 : a.e.key > b.e.key ? 1 : 0));
    const sections = bySource ? ["Top hit","Insert","Library","Commands","Settings","Components","Pins and pads","Nets","Ports and labels","Documents","Recent files","Notebook","Help","Clipboard","Jumps"]
      : ["Top hit","Insert","Commands","Jumps"];
    const groups = new Map(ctx && !mode ? sections.map(name => [name,[]]) : []);
    for (let i=0; i<rows.length; i++) {
      const e = rows[i].e, name = ctx && !mode && i === 0 ? "Top hit" : localGroup(e);
      if (!groups.has(name)) groups.set(name,[]);
      const group = groups.get(name);
      if (group.length < (mode ? LIMIT : 8)) group.push(e);
    }
    const out = groupEntries(groups,null,hits.total + rows.length - hits.length);
    out.ms = now() - t;
    return out;
  }

  const commandScope = () => dialog.hasAttribute("data-palette-commands");
  // Find (the project's objects) and Quick Open (documents) narrow the one palette; the chip or Backspace widens it.
  const entryScope = () => dialog?.dataset.paletteScope || "";
  function setCommandScope(enabled) {
    dialog.toggleAttribute("data-palette-commands",enabled);
    if (!enabled) delete dialog.dataset.paletteScope;
    if (!enabled && session?.mode === "command") session = Object.freeze({...session,mode:"search"});
  }
  function absorbPrefix() {
    if (input.value.startsWith(">")) {
      const {selectionStart, selectionEnd, selectionDirection} = input;
      input.value = input.value.slice(1);
      input.setSelectionRange(Math.max(0,selectionStart-1),Math.max(0,selectionEnd-1),selectionDirection);
      setCommandScope(true);
    } else if (commandScope() && (/^[@:]/.test(input.value) || session?.enhanced && input.value.startsWith("/"))) {
      setCommandScope(false);
    }
  }
  function currentSearch() {
    const parsed = parse(input.value);
    return commandScope() && !parsed.mode ? {...parsed,mode:">"} : parsed;
  }

  let queryNumber = 0;
  function stopQuery() {
    if (!query) return;
    query.controller.abort(); query.answerController?.abort(); clearTimeout(query.timer); cancelAnimationFrame(query.frame || 0);
    for (const name of streamGroups) IX?.setGroup(name,[]);
    streamGroups.clear(); query = null;
  }
  function render(instant = false) {
    if (!query || !view) return;
    const {mode,q} = currentSearch();
    const loading = query.designQuery ? query.designQuery === "loading" : query.catalogue === "loading" || !IX || indexedAt !== indexChanges;
    view.results(results,{q,mode,entryMode:session.mode,active,instant,recent,loading,
      counting:query.designQuery === "loading",diagnostic:query.diagnostic,total:results.total});
    lastSearch = {q,mode,total:results.total,ms:results.ms ?? null,groups:[...new Set(results.groups.map(g => g.name).filter(Boolean))]};
  }
  function setActive(i, scroll = true, event) {
    if (!results[i]) return;
    active = i; view?.select(i,{scroll,event,instant:!event || event.type === "keydown"});
  }
  function appendRows(rows, name, source, heading) {
    if (!query || !rows.length) return;
    const keys = new Set(results.map(e => e.key)), added = [];
    for (const e of rows) if (!keys.has(e.key)) {keys.add(e.key); added.push(e);}
    if (!added.length) return;
    const groups = results.groups;
    const current = heading ? groups.find(group => group.name === name && group.heading === heading && group.source === source) : groups.at(-1);
    if (current?.name === name && current.heading === heading && current.source === source) {
      const end = current.start + current.count;
      results.splice(end,0,...added);
      current.count += added.length; current.total += added.length;
      if (active >= end) active += added.length;
      for (let i=groups.indexOf(current)+1; i<groups.length; i++) groups[i].start += added.length;
    } else {
      const start = results.length;
      results.push(...added);
      groups.push({name,heading,start,count:added.length,total:added.length,...(source ? {remote:true,source} : {})});
    }
    results.total = Math.max(results.length,results.total || 0);
  }
  function scheduleRefresh() {
    if (!dialog?.open || !query || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      if (!dialog.open || !query) return;
      update(false);
    });
  }
  function refreshIndexedResults() {
    // The stock empty browse uses live sources directly. Indexed additions can
    // affect a typed search or the empty-state message, and edits can change those live rows.
    if (!session?.enhanced && query?.sourceVersion === indexChanges && results.length && !currentSearch().q) return;
    scheduleRefresh();
  }
  function appendFreshLocal(next) {
    // Existing slots retain both order and identity on async source/shortcut updates.
    // Refresh their labels and callbacks in place; additions follow the existing rows of their section.
    const fresh = new Map(next.map(e => [e.key,e])), groups = results.groups, selected = results[active]?.key;
    // A library family can stop matching or an extension contribution can retire.
    // Remove their rows while keeping the other results in place.
    for (let g = groups.length - 1; g >= 0; g--) {
      const group = groups[g];
      let removed = 0;
      for (let i = group.start + group.count - 1; i >= group.start; i--) {
        const e = results[i];
        const retiredStream = e.stream && !IX.has(e.key);
        const retiredFamily = e.kind === "library" && e.family && !fresh.has(e.key) && IX.get(e.key)?.family !== e.family;
        if (!retiredStream && !retiredFamily) continue;
        results.splice(i,1); removed++;
      }
      if (!removed) continue;
      group.count -= removed; group.total -= removed; results.total -= removed;
      for (let i = g + 1; i < groups.length; i++) groups[i].start -= removed;
      if (!group.count) {
        results.total -= group.total;
        groups.splice(g,1);
      }
    }
    const at = results.findIndex(e=>e.key === selected);
    active = at >= 0 ? at : Math.max(0,Math.min(active,results.length - 1));
    for (let i = 0; i < results.length; i++) {
      const e = results[i];
      if (e.provider && !e.stream && !IX.has(e.key)) results[i] = {...e,disabled:true,run:null};
    }
    for (let i = 0; i < results.length; i++) if (fresh.has(results[i].key)) results[i] = fresh.get(results[i].key);
    for (const g of next.groups) appendRows(next.slice(g.start,g.start+g.count),g.name,g.source,g.heading);
    results.total = Math.max(results.length,next.total,results.total); results.ms = next.ms;
  }
  function stream(q) {
    const request = requestOf(), captured = query;
    const valid = () => query === captured && !request.signal.aborted;
    const pending = [];
    function emit(id,batch) {
      if (!valid() || !Array.isArray(batch)) return;
      const n = captured.counts.get(id) || 0;
      if (n >= 32 || captured.received >= 96) return;
      const rows = batch.slice(0,Math.min(32-n,96-captured.received)).filter(e => e && typeof e.key === "string" && typeof e.label === "string");
      captured.received += rows.length; captured.counts.set(id,n + rows.length);
      if (!rows.length) return;
      pending.push({id,rows});
      if (captured.frame) return;
      captured.frame = requestAnimationFrame(() => {
        captured.frame = 0; if (!valid()) return;
        for (const part of pending.splice(0)) {
          const name = "stream:" + captured.id + ":" + captured.batch++;
          const entries = part.rows.filter(e => !IX.has(e.key) && e.isCurrent?.() !== false).map(e => ({...e,provider:part.id,stream:true,boost:0,kind:e.kind || "command"}));
          if (!entries.length) continue;
          streamGroups.add(name); IX.setGroup(name,entries);
          const filter = r => r.e?.stream && entries.includes(r.e);
          const matched = IX.search(q,{limit:32,filter,usage:key => usage.get(key) || 0}).map(h => entryOf(h.rec));
          // Remote sources can match fields that the host deliberately never receives.
          const rankedKeys = new Set(matched.map(e => e.key));
          const omitted = entries.filter(e => !rankedKeys.has(e.key)).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
          for (const e of [...matched,...omitted]) appendRows([e],String(e.source || providers.get(part.id)?.label || "Extensions"),part.id);
        }
        render();
      });
    }
    for (const [id,provider] of providers) if (provider.stream) {
      let timing;
      const cancel = () => timing.end("cancelled");
      const finish = outcome => {
        if (!timing) return;
        request.signal.removeEventListener("abort",cancel);
        timing.end(valid() ? outcome : "cancelled");
      };
      Promise.resolve().then(() => {
        if (!valid()) return;
        timing = globalThis.AtriumDiagnostics?.performance?.begin("search", "request");
        if (timing) request.signal.addEventListener("abort",cancel,{once:true});
        return provider.stream(request,batch => emit(id,batch));
      }).then(batch => {
        try {
          if (Array.isArray(batch)) emit(id,batch);
          finish("completed");
        } catch (error) {
          finish("failed");
          throw error;
        }
      }, error => finish(error?.name === "AbortError" ? "cancelled" : "failed"));
    }
  }
  const spatialQuery = node => node?.type === "near" || node?.args?.some(spatialQuery) || node?.arg && spatialQuery(node.arg);
  async function designResults(captured,mode,source) {
    const project = host.project(), {docId,instanceId} = session, signal = captured.controller.signal;
    let revision;
    const current = () => query === captured && !signal.aborted && host.project() === project &&
      (revision == null || host.revision?.() === revision);
    const timing = globalThis.AtriumDiagnostics?.performance?.begin("search", "search");
    let outcome = "cancelled";
    try {
      const service = await globalThis.AtriumLabs.designQueryService(source);
      if (!current()) return;
      if (!service) { update(true,false); return; }
      const spatial = spatialQuery(globalThis.AtriumDesignQuery.parse(source).ast);
      if ((!spatial || instanceId) && host.folderProject?.() && !host.folderProject().completeFor("project")) {
        captured.hydrating = true;
        try { await host.requireProjectClosure({purpose:"project",signal}); }
        finally { captured.hydrating = false; }
      }
      if (!current()) return;
      revision = host.revision?.();
      const queryScope = spatial || instanceId ? {documentId:docId,instanceId} : {};
      const docs = new Map(project.documents.map(d => [d.id,d.name]));
      function publish(result) {
        const entries = result.rows.map(row => {
          const {documentId,id,kind,ownerId,pin,padIndex,padId,instanceId,fields} = row;
          const net = fields["net.name"];
          const type = kind === "part" ? "component" : kind;
          const target = {type,docId:documentId,id,ownerId,net,pad:pin,padIndex,padId,instanceId};
          const key = "query:" + JSON.stringify([documentId,instanceId,id]);
          const label = pin != null ? [fields.designator || ownerId,pin].join(".") :
            fields.designator || fields.name || fields.text || (net ? kind === "net" ? net : titleCase(kind) + " · " + net : id);
          return {key,kind:type,label,detail:[docs.get(documentId),fields.layer].filter(Boolean).join(" · "),target,
            async run() {
              return gotoObject(target, () => host.project() === project && host.revision?.() === revision);
            }};
        });
        const more = result.complete ? globalThis.AtriumIntelUI?.queryRows(source,result,queryScope) ?? [] : [];
        results = groupEntries(more.length ? [["Objects",entries],["Query",more]] : [["Objects",entries]],null,result.count ?? result.lowerBound);
      }
      const result = await service.search(source,{project,revision,signal,isCurrent:current,
        enabled:() => globalThis.AtriumLabs.butterEnabled("query"),limit:mode === "@" ? LIMIT : 24,
        fields:["designator","name","text","net.name","layer"],...queryScope,onPage:page => {
          if (!current() || page.status !== "counting" || !page.rows.length) return;
          publish(page); render();
        }});
      if (!current()) return;
      if (result.status === "disabled") { update(true,false); return; }
      if (!result.complete) captured.diagnostic = result.diagnostic?.message;
      if (result.rows) publish(result);
      else results = groupEntries([]);
      outcome = result.complete ? "completed" : "failed";
    } catch (error) {
      if (!current()) return;
      captured.diagnostic = error.message;
      outcome = error?.name === "AbortError" ? "cancelled" : "failed";
    } finally {
      timing?.end(outcome);
    }
    captured.designQuery = "ready";
    render();
  }
  function update(newQuery = true, allowDesign = true) {
    if (!dialog?.open || !session || !view || !IX) return;
    const {mode,q} = currentSearch();
    if (mode || !q) {scope = ""; scopedProvider = null;}
    if (newQuery) {
      stopQuery();
      query = {id:++queryNumber,text:input.value,controller:new AbortController(),counts:new Map(),received:0,batch:0};
      active = 0;
    }
    if (!newQuery && query.designQuery) return;
    if (newQuery && allowDesign && (!mode || mode === "@") && !scope && !session.surface &&
        (mode === "@" || session.mode !== "insert") && globalThis.AtriumLabs?.designQueryIntent(q)) {
      stopIndex();
      query.designQuery = "loading";
      results = groupEntries([]);
      render(true);
      void designResults(query,mode,q);
      return;
    }
    const rich = session.enhanced;
    query.sourceVersion = indexChanges;
    const timing = globalThis.AtriumDiagnostics?.performance?.begin("search", "search");
    let next;
    try {
      next = !rich && !q && mode !== ":" ? search(sources(mode,q),"",{recent}) : ranked(mode,q,rich ? session : null,true);
      timing?.end("completed");
    } catch (error) {
      timing?.end("failed");
      throw error;
    }
    next.groups ??= [];
    next.total ??= next.length;
    next = arrangeCommandMatches(next,mode,!rich);
    if (rich && !next.length && !mode && !scope && q && query.catalogue !== "loading" && indexedAt === indexChanges) {
      const fallback = [];
      for (const p of providers.values()) if (p.fallback) fallback.push(...(p.fallback(requestOf()) || []));
      if (fallback.length) {next.push(...fallback); next.total = next.length; next.groups.push({name:"Actions",start:0,count:next.length,total:next.length});}
    }
    const calc = globalThis.AtriumCalculationIntent || globalThis.AtriumCalculations;
    if (rich && newQuery && !mode && !scope && (calculationAvailable || globalThis.AtriumCalculations) && calc?.acceptsPaletteText?.(input.value,session)) {
      next.unshift(pendingAnswer(input.value));
      for (const g of next.groups) g.start++;
      next.groups.unshift({name:"Answer",start:0,count:1,total:1}); next.total++;
      query.answer = true;
    }
    if (newQuery || !rich || !results.length) results = next;
    else appendFreshLocal(next);
    render(newQuery);
    if (rich && newQuery && !mode && q) {
      if (query.answer) quickAnswer();
      query.timer = setTimeout(() => stream(q),90);
    }
    requestIndex();
  }
  function pendingAnswer(text) {return {key:"calc:answer",kind:"answer",label:t("palette.calculating"),detail:text,run:null};}
  function quickAnswer() {
    const captured = query, revision = host.revision?.(), text = captured.text, ctx = session;
    captured.answerController?.abort();
    const controller = new AbortController(), signal = controller.signal;
    captured.answerController = controller;
    const prior = results.findIndex(e => e.key === "calc:answer" && e.answer);
    if (prior >= 0) {results[prior] = pendingAnswer(text); render();}
    const req = {queryId:captured.id,text,projectRevision:revision,documentId:ctx.docId,selection:ctx.selection,instanceId:ctx.instanceId};
    const current = () => query === captured && !signal.aborted && host.revision?.() === revision;
    function display(answer, message) {
      const at = results.findIndex(e => e.key === "calc:answer");
      if (at < 0 || !current()) return;
      const ready = answer?.state === "ready";
      results[at] = {key:"calc:answer",kind:"answer",label:answer?.display || answer?.message || message,
        detail:ready ? text : "",answer,run:ready ? () => navigator.clipboard.writeText(answer.copyText) : null};
      render();
    }
    // The service owns the parser, units, live fields, formatting and edit eligibility.
    const service = globalThis.AtriumCalculations || globalThis.AtriumLazy?.need("AtriumCalculations");
    Promise.resolve(service).then(calc => current() && calc?.answer(req,{signal})).then(answer => {
      if (answer && (answer.queryId !== captured.id || answer.projectRevision !== revision)) return;
      display(answer,t("palette.no_answer"));
    },error => display(null,error?.message || t("palette.answer_unavailable")));
  }
  function actionList(i) {
    const e = results[i]; if (!e) return [];
    const req = requestOf(e), list = [], label = globalThis.AtriumPaletteView.resultTitle(e);
    if (e.answer?.state === "ready") {
      const names = {copy:t("palette.copy_result"),insert:t("palette.insert_calculation"),apply:t("palette.apply_calculation")};
      for (const action of e.answer.actions || []) if (names[action] && (action === "copy" || !session.surface && session.kind === "schematic")) {
        list.push({id:"answer:"+action,label:names[action],keepOpen:true,run:() => run(i,{},action === "copy" ? null : action)});
      }
    }
    if (e.run && !e.disabled && !list.length) {
      const verb = section(e) === "Insert" ? "palette.insert_item" : e.kind === "command" ? "palette.run_item" : "palette.open_item";
      list.push({id:"primary",label:t(verb,{name:label}),hint:"Enter",keepOpen:true,run:() => run(i)});
    }
    if (session.enhanced) list.push(...globalThis.AtriumPaletteActions?.actions?.(e,req) || [],
      ...e.actions || [], ...globalThis.AtriumPalettePersonal?.actions?.(e,req) || []);
    if (e.options?.length) list.push({id:"options",label:t("palette.edit_options"),keepOpen:true,run:() => options(i)});
    if (globalThis.navigator?.clipboard?.writeText) list.push({id:"copy-label",label:t("palette.copy_name"),run:() => navigator.clipboard.writeText(label)});
    return list.map(a => ({...a,run:() => {
      const signal = a.keepOpen ? req.signal : req.context.labsSignal;
      if (!a.keepOpen) close(false);
      Promise.resolve().then(() => !signal?.aborted && a.run({...req,signal})).catch(error=>report(error,signal));
    }}));
  }
  function actions(i) {return !!session && view?.actions(i,actionList(i));}
  function options(i) { if (results[i]?.options?.length) view?.options(i,requestOf(results[i])); else actions(i); }
  function report(error,signal) {if (!signal?.aborted) host?.info?.(error?.message || String(error));}
  function run(i, values, modifier) {runEntry(results[i],values,modifier);}
  function runEntry(e, values = {}, modifier) {
    if (!e?.run || e.disabled) return;
    const req = requestOf(e,values), apply = modifier && e.answer;
    if (e.answer) {
      const liveInstance = host.instanceId || globalThis.AtriumConnectionPreview ? C.paletteInstance(host,session.docId) : session.instanceId;
      const selected = host.selection?.() || session.selection;
      if (liveInstance !== session.instanceId || selected.length !== session.selection.length || selected.some(id => !session.selection.includes(id))) {
        session = Object.freeze({...session,instanceId:liveInstance,selection:Object.freeze([...selected])});
        quickAnswer(); return;
      }
      if (e.answer.projectRevision !== host.revision?.()) {quickAnswer(); return;}
    }
    if (apply && (session.surface || session.kind !== "schematic" || !e.answer.actions?.includes(modifier))) return;
    const actionSignal = e.keepOpen ? req.signal : req.context.labsSignal;
    const invoke = apply ? () => globalThis.AtriumCalculations?.applyPaletteAnswer(e.answer,modifier,req.context) : () => e.run({...req,signal:actionSignal});
    remember(e.key);
    // Declarative extension commands can open their own view in this same dialog.
    if (!e.keepOpen) close(false);
    const failed = error => report(error,actionSignal);
    try {Promise.resolve(invoke()).catch(failed);} catch (error) {failed(error);}
  }
  function keys(e) {
    e.stopPropagation();
    if (e.isComposing || e.key === "Process") return;
    if (e.key === "Backspace" && !input.value && (commandScope() || entryScope())) {
      e.preventDefault(); nextChord = null; setCommandScope(false); update(); return;
    }
    if (nextChord?.(e,rec => {close(); globalThis.AtriumKeymap.invoke(rec,(a,p) => host?.executeKey?.(a,p));})) {e.stopPropagation(); return;}
    if (view?.actionsKey(e)) {e.preventDefault(); actions(active); return;}
    const step = {ArrowDown:1,ArrowUp:-1,PageDown:10,PageUp:-10}[e.key];
    if (step && results.length) {e.preventDefault(); setActive(Math.abs(step) === 1 ? (active+step+results.length)%results.length : Math.max(0,Math.min(results.length-1,active+step)),true,e); return;}
    if (e.key === "Enter") {e.preventDefault(); run(active,{},e.altKey ? "insert" : e.shiftKey ? "apply" : null); return;}
    if (e.key === "Escape") {e.preventDefault(); close(); return;}
    if (e.key === "Tab" && !e.shiftKey && results[active]?.options?.length) {e.preventDefault(); options(active);}
  }
  function build(d) {
    dialog = d; input = d.querySelector("[role=combobox]");
    const typed = () => {
      if (d.paletteRequest?.supportDeferred) loadSupport(d.paletteRequest);
      nextChord = null;
      const scoped = commandScope(), was = entryScope();
      absorbPrefix();
      if (scoped !== commandScope() || was !== entryScope() || query?.text !== input.value) update();
    };
    input.addEventListener("input",event => {if (!event.isComposing) typed();});
    input.addEventListener("compositionend",typed);
    d.querySelector(".nav-palette-scope-chip").addEventListener("click",() => {
      nextChord = null; setCommandScope(false); input.focus({preventScroll:true}); update();
    });
    input.addEventListener("keydown",keys);
    dialog.addEventListener("cancel",e => {if (!e.defaultPrevented) {e.preventDefault(); close();}});
    dialog.addEventListener("click",e => {if (e.target === dialog) close();});
    dialog.addEventListener("close",() => {if (dialog === d && !d.open && (session || d.paletteRequest)) reset();});
  }
  function activate(raw) {
    const ctx = snapshot(raw);
    session = ctx;
    startIndex(); refreshSources();
    if (ctx.enhanced) collectInline();
    const openedAt = Date.now();
    usage = new Map(Object.keys(usageMap()).map(key => [key,usageBonus(key,openedAt)]));
    recent.forEach((key,i) => {if (!usage.has(key)) usage.set(key,20-i);});
    if (!view) view = globalThis.AtriumPaletteView.create(dialog,{choose:setActive,run,close,options,actions,request:i => requestOf(results[i])});
    view.open(session); absorbPrefix(); update();
    if (ctx.enhanced && raw.entryKey?.startsWith("command:ext:")) {
      const initialQuery = query;
      const shortcut = () => {
        const e = IX.get(raw.entryKey)?.e;
        if (e?.provider !== "extensions" || e.kind !== "command") return false;
        runEntry(e);
        return true;
      };
      if (!shortcut()) Promise.resolve(globalThis.AtriumExtensions?.readyNotebook?.()).then(() => globalThis.AtriumExtensionPalette?.ready()).then(() => {
        if (dialog?.open && dialog.paletteRequest === raw && session === ctx && query === initialQuery) shortcut();
      });
    }
    restoreLibrarySources();
    if (!ctx.surface) {
      const refresh = files => {
        if (!files || !dialog?.open || dialog.paletteRequest !== raw) return;
        const next = fileEntries();
        if (next.length || IX.source("files").length) {
          IX.setGroup("files",next); scheduleRefresh();
        }
      };
      Promise.resolve(globalThis.AtriumHost?.refreshRecentFiles?.()).then(refresh,() => {});
      Promise.resolve(globalThis.AtriumAutosave?.refreshRecent?.()).then(refresh,() => {});
    }
  }
  function collectInline() {
    inline = new Map();
    for (const id of providers.keys()) for (const e of IX.source("provider:" + id)) {
      for (const word of e.inline || []) if (!inline.has(word)) inline.set(word,e.key);
    }
  }
  const librariesObserved = new WeakSet();
  function observeLibrary(source) {
    if (source?.onChange && !librariesObserved.has(source)) {
      librariesObserved.add(source);
      source.onChange(kind => {if (kind !== "progress") {indexChanges++; requestIndex();}});
    }
  }
  function restoreLibrarySources() {
    const L = globalThis.AtriumLazy;
    if (!librariesRequested.has("sources")) {
      librariesRequested.add("sources");
      globalThis.addEventListener?.("waffle-library-sources",() => {indexChanges++; requestIndex();});
    }
    const setups = [
      ["atrium.library-folders.v1","AtriumLibrarySourcesUI",() => globalThis.AtriumLibrarySources],
      ["atrium.group-library.v1","AtriumGroupLibraryUI",() => globalThis.AtriumGroupLocal],
      ["atrium.libraries.v1","AtriumLibrary",() => null]
    ];
    for (const [key,name,source] of setups) {
      observeLibrary(source());
      let stored; try {stored = globalThis.localStorage?.getItem(key);} catch {}
      if (!stored || stored === "[]" || !L || librariesRequested.has(name)) continue;
      librariesRequested.add(name);
      L.need(name).then(module => {
        const service = source(); observeLibrary(service);
        if (name === "AtriumLibrarySourcesUI") module.restore();
        else if (name === "AtriumGroupLibraryUI") service?.restore?.();
        indexChanges++; requestIndex();
      },() => librariesRequested.delete(name));
    }
  }
  const librariesRequested = new Set();
  function loadSupport(raw) {
    raw.supportDeferred = false;
    const L = globalThis.AtriumLazy;
    if (raw.enhanced && !globalThis.AtriumPalettePersonal && L.modules().includes("AtriumPalettePersonal"))
      L.need("AtriumPalettePersonal").catch(() => {});
    if (!globalThis.AtriumSearchData)
      L.need("AtriumSearchData").then(() => {staticSources(); refreshIndexedResults();},() => {});
  }
  function resume(d, raw) {
    if (!dialog) build(d);
    if (raw.enhanced) globalThis.AtriumExtensionPalette?.connect();
    previous = raw.previous; nextChord = raw.continuation; scope = ""; scopedProvider = null;
    stopQuery(); session = null; results = []; active = 0;
    const begin = () => {
      if (!d.open || d.paletteRequest !== raw || raw.enhanced !== enhanced()) return;
      if (raw.docId && raw.docId !== host.currentId()) {close(false); return;}
      activate(raw);
      if (raw.supportDeferred) globalThis.AtriumIdle.afterFrame(() => {
        if (d.open && d.paletteRequest === raw && raw.supportDeferred) loadSupport(raw);
      });
    };
    const L = globalThis.AtriumLazy;
    const modules = L.modules();
    calculationAvailable = !!globalThis.AtriumCalculations || modules.includes("AtriumCalculations");
    const needed = ["AtriumSearchIndex","AtriumPaletteWords"];
    if (raw.enhanced) {
      needed.push("AtriumWidgetCatalogue","AtriumPaletteActions");
      if (calculationAvailable && modules.includes("AtriumCalculationIntent")) needed.push("AtriumCalculationIntent");
    }
    needed.push("AtriumPaletteView");
    // A cold, empty Insert view can show its local choices before loading
    // personalization and help. A typed query immediately demands both sources.
    raw.supportDeferred = !IX && d.dataset.mode === "insert" && !input.value;
    if (needed.every(n => globalThis[n])) begin();
    else {
      // The command index is independent of the cold result view. Keep the existing request,
      // document and Labs checks while the view is still loading.
      if (!IX && !raw.surface) L.need(["AtriumSearchIndex","AtriumPaletteWords"]).then(() => {
        if (d.open && d.paletteRequest === raw && raw.enhanced === enhanced() &&
            (!raw.docId || raw.docId === host.currentId()) && !session && !IX) startIndex();
      }, () => {});
      L.need(needed).then(begin,report);
    }
    if (!raw.supportDeferred) loadSupport(raw);
  }
  function open(prefix = ">", continuation = null, at = {}) {return typeof document !== "undefined" ? C.openPalette(prefix,continuation,at) : null;}
  function setScope(kind,text,providerId) {
    if (!dialog?.open || !["library","help","provider",""].includes(kind)) return;
    setCommandScope(false);
    scope = kind; scopedProvider = providerId || null; input.value = String(text || "");
    input.focus(); absorbPrefix(); update();
  }
  function reset() {
    stopQuery(); stopIndex(); view?.close();
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    refreshFrame = 0;
    if (session?.surface) {
      for (const group of ["surface","commands",...Array.from(providers.keys(),id => "provider:" + id)]) IX?.setGroup(group,[]);
    }
    dialog.paletteRequest = null;
    session = null; results = []; active = 0; nextChord = null; previous = null;
  }
  function resetMode() {
    if (dialog) reset();
    for (const name of providers.keys()) IX?.setGroup("provider:" + name,[]);
    IX?.setGroup("surface",[]);
    commandCache = null; legacyDirty = true; indexChanges++; staticSources();
    dialog = null; input = null; view = null;
    if (enhanced()) globalThis.dispatchEvent?.(new CustomEvent("waffle-palette-ready"));
  }
  function close(refocus = true) {
    if (!dialog?.open) return;
    const old = previous;
    reset(); dialog.close(); previous = null;
    if (refocus) (old?.isConnected && old.checkVisibility?.() !== false ? old : host?.canvas())?.focus?.({preventScroll:true});
  }
  function attach(h) {
    host = h; legacyDirty = true;
    host.on("document",() => {commandCache = null; legacyDirty = true; indexChanges++; stopIndex(); if (dialog?.open) close(false);});
    host.on("change",detail => {
      if (detail?.source === "pours") return;
      indexChanges++; legacyDirty = true; stopIndex(); requestIndex();
      if (query?.answer) quickAnswer();
      if (query?.designQuery && !query.hydrating) update();
    });
    globalThis.AtriumPrefs?.on("butter.query", () => { if (dialog?.open && query?.designQuery) update(); });
    globalThis.AtriumPower?.onChange?.(({visible}) => {if (visible) requestIndex(); else stopIndex();});
  }
  C?.ready(attach);
  if (typeof window !== "undefined" && enhanced()) queueMicrotask(() => {if (enhanced()) globalThis.dispatchEvent(new CustomEvent("waffle-palette-ready"));});
  return {parse, parseLocation, search, titleCase, objectEntries, open, resume, close, resetMode, isOpen:() => !!dialog?.open, registerProvider,invalidateProvider,toolGroup,
    actions, scope:setScope, present:(model,callbacks) => dialog?.open && session?.enhanced && view?.present?.(model,callbacks),context:() => session,
    entries:mode => sources(mode || "", ""), recent:() => recent.slice(), remember, attach,
    searchAll(q,mode="") {
      if (!IX || !host) return null;
      if (!session && legacyDirty) {IX.setGroup("commands",commandEntries()); IX.setGroup("files",fileEntries()); IX.setGroup("settings",settingEntries()); legacyDirty = false;}
      return ranked(mode,q,session);
    },
    index:() => IX,startIndex,readyIndex,indexStats:() => indexStats && {...indexStats,...IX?.stats()},lastSearch:() => lastSearch,usageBonus};
})();
