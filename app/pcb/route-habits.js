"use strict";
// Routing habits: a small, human-readable profile learned from the user's own accepted
// suggestions and hand-routed tracks, used only to weigh legal choices in Route Suggestions
// (route-suggest-engine.js). Rules always win: a habit never changes a clearance, never picks a
// width outside the Width rule and never overrides the Routing Corners rule; every suggestion is
// audited exactly after the habits have weighed it.
//
// Privacy: the profile lives in this browser's local storage, per user ("atrium.routing.habits")
// or per project ("atrium.routing.habits@<project name>"). It is never written into the project
// file unless exported, and never sent anywhere. Preferences › Route Suggestions shows it, resets
// it and turns learning off (routing.habits).
//
// Profile (format atrium-routing-habits, version 1), all lengths in mm:
//   routes                     routes learned
//   classes[cls].layers[L]     track length per layer for the net class
//   classes[cls].widths[w]     track length per width ("0.2")
//   classes[cls].routes, vias  routes and vias of the class
//   classes[cls].neck          {seen, necked} pad entries narrower than the track
//   dirs[L]                    {h, v, d} length by direction per layer
//   corners                    {"45", "90", any, arc} corner counts
//   exit                       {long, short} first segment along the pad's long or short axis
//   fanout                     {out, in} vias placed away from / towards the part's centre
//   spacing                    {samples, extra} mean clearance beyond the rule (from the audit)
globalThis.AtriumRouteHabits = (() => {
  const FORMAT = "atrium-routing-habits", VERSION = 1, KEY = "atrium.routing.habits";
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const r3 = v => Math.round(v * 1000) / 1000;
  const storage = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  const listeners = new Set();
  function empty() { return {format: FORMAT, version: VERSION, routes: 0, updated: null, classes: {}, dirs: {}, corners: {"45": 0, "90": 0, any: 0, arc: 0}, exit: {long: 0, short: 0}, fanout: {out: 0, in: 0}, spacing: {samples: 0, extra: 0}}; }
  // Accepts any older or partial profile; unknown fields are dropped.
  function clean(p) {
    const out = empty();
    if (!p || typeof p !== "object" || p.format !== FORMAT) return out;
    out.routes = finite(p.routes) ? Math.max(0, p.routes) : 0; out.updated = typeof p.updated === "string" ? p.updated.slice(0, 32) : null;
    const num = o => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k, v]) => k.length < 64 && finite(v) && v >= 0).slice(0, 64));
    for (const [cls, c] of Object.entries(p.classes && typeof p.classes === "object" ? p.classes : {}).slice(0, 64)) {
      if (typeof cls !== "string" || cls.length > 128 || !c || typeof c !== "object") continue;
      out.classes[cls] = {routes: finite(c.routes) ? c.routes : 0, vias: finite(c.vias) ? c.vias : 0, layers: num(c.layers), widths: num(c.widths), neck: {seen: finite(c.neck?.seen) ? c.neck.seen : 0, necked: finite(c.neck?.necked) ? c.neck.necked : 0}};
    }
    for (const [L, d] of Object.entries(p.dirs && typeof p.dirs === "object" ? p.dirs : {}).slice(0, 130)) out.dirs[L] = {h: finite(d?.h) ? d.h : 0, v: finite(d?.v) ? d.v : 0, d: finite(d?.d) ? d.d : 0};
    Object.assign(out.corners, num(p.corners)); Object.assign(out.exit, num(p.exit)); Object.assign(out.fanout, num(p.fanout));
    if (finite(p.spacing?.samples)) out.spacing = {samples: p.spacing.samples, extra: finite(p.spacing.extra) ? p.spacing.extra : 0};
    return out;
  }

  // ------------------------------------------------------------------ storage
  const pref = (k, d) => { try { const v = (globalThis.AtriumPref || globalThis.AtriumPrefs)?.get?.(k); return v === undefined || v === null ? d : v; } catch { return d; } };
  const enabled = () => pref("routing.habits", false) === true;
  const scope = () => pref("routing.habitsScope", "user");
  function keyFor(project) { return scope() === "project" && project?.name ? KEY + "@" + String(project.name).slice(0, 120) : KEY; }
  const memory = new Map();
  function load(project) {
    const k = keyFor(project);
    if (memory.has(k)) return memory.get(k);
    let p = empty();
    try { const raw = storage?.getItem(k); if (raw) p = clean(JSON.parse(raw)); } catch { /* corrupt or blocked: start empty */ }
    memory.set(k, p); return p;
  }
  function save(project, p) {
    const k = keyFor(project); memory.set(k, p);
    try { storage?.setItem(k, JSON.stringify(p)); } catch { /* storage full or blocked: keep in memory */ }
    for (const f of [...listeners]) try { f(p); } catch { /* listener */ }
  }
  function reset(project) {
    const k = keyFor(project); memory.delete(k);
    try { storage?.removeItem(k); } catch { /* blocked */ }
    for (const f of [...listeners]) try { f(empty()); } catch { /* listener */ }
    return empty();
  }

  // ------------------------------------------------------------------ learning
  function classOf(board, net, project) {
    try {
      const classes = globalThis.AtriumRules?.netClasses?.(board, {project}) || {};
      for (const [k, list] of Object.entries(classes)) if (k !== "All Nets" && Array.isArray(list) && list.includes(net)) return k;
    } catch { /* rules optional */ }
    return "Default";
  }
  const dirOf = (a, b) => { const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return dy < 0.2 * dx ? "h" : dx < 0.2 * dy ? "v" : "d"; };
  // Pads at a point (centre within the pad), with the part they belong to.
  function padAt(board, defs, p) {
    const A = globalThis.Atrium;
    for (const it of board.items) {
      if (it.kind !== "part") continue;
      const fp = defs?.get?.(it.def)?.footprint; if (!fp) continue;
      if (Math.hypot(it.x - p[0], it.y - p[1]) > 30) continue;
      for (const pad of fp.pads || []) {
        const c = A.world([pad.x, pad.y], it), w = pad.w || pad.diameter || 0, h = pad.h || pad.diameter || 0;
        if (Math.hypot(c[0] - p[0], c[1] - p[1]) <= Math.max(w, h) / 2 + 1e-3) {
          const ang = ((it.angle || 0) + (pad.angle || 0)) * Math.PI / 180, long = w >= h ? [Math.cos(ang), Math.sin(ang)] : [-Math.sin(ang), Math.cos(ang)];
          return {centre: c, w, h, long, part: it, square: Math.abs(w - h) < 1e-6};
        }
      }
    }
    return null;
  }
  // Adds one route (an edit plan's new tracks and vias, one net) to a profile.
  function observeInto(p, board, defs, plan, o = {}) {
    const tracks = (plan.add || []).filter(i => i.kind === "track" && Array.isArray(i.points) && i.points.length > 1);
    if (!tracks.length) return false;
    const vias = (plan.add || []).filter(i => i.kind === "via");
    const net = tracks[0].net || "", cls = o.cls || classOf(board, net, o.project);
    const c = p.classes[cls] ||= {routes: 0, vias: 0, layers: {}, widths: {}, neck: {seen: 0, necked: 0}};
    c.routes++; c.vias += vias.length; p.routes++;
    for (const t of tracks) {
      let L = 0;
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1], b = t.points[i], s = Math.hypot(b[0] - a[0], b[1] - a[1]); L += s;
        const d = p.dirs[t.layer] ||= {h: 0, v: 0, d: 0}; d[dirOf(a, b)] = r3(d[dirOf(a, b)] + s);
        if (i < t.points.length - 1) {
          const c0 = t.points[i + 1], a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c0[1] - b[1], c0[0] - b[0]);
          let turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
          const deg = turn * 180 / Math.PI;
          if (deg < 3) continue;
          if (deg < 20 && t.points.length > 6) p.corners.arc++;
          else if (Math.abs(deg - 45) < 3) p.corners["45"]++;
          else if (Math.abs(deg - 90) < 3) p.corners["90"]++;
          else p.corners.any++;
        }
      }
      c.layers[t.layer] = r3((c.layers[t.layer] || 0) + L);
      const wk = String(r3(t.width));
      c.widths[wk] = r3((c.widths[wk] || 0) + L);
    }
    // Pad exits and neck-downs at each end of the route.
    if (defs && o.pads !== false) {
      for (const t of tracks) for (const [end, next] of [[t.points[0], t.points[1]], [t.points[t.points.length - 1], t.points[t.points.length - 2]]]) {
        const pad = padAt(board, defs, end); if (!pad) continue;
        const ux = next[0] - end[0], uy = next[1] - end[1], L = Math.hypot(ux, uy); if (L < 1e-6) continue;
        if (!pad.square) { const along = Math.abs((ux * pad.long[0] + uy * pad.long[1]) / L); if (along > 0.9) p.exit.long++; else if (along < 0.45) p.exit.short++; }
        if (Math.min(pad.w, pad.h) < t.width * 1.2) { c.neck.seen++; if (t.width < Math.min(pad.w, pad.h) - 1e-6) c.neck.necked++; }
      }
      for (const v of vias) {
        const near = board.items.filter(i => i.kind === "part" && Math.hypot(i.x - v.x, i.y - v.y) < 15).sort((a, b) => Math.hypot(a.x - v.x, a.y - v.y) - Math.hypot(b.x - v.x, b.y - v.y))[0];
        if (!near) continue;
        const start = tracks.find(t => Math.hypot(t.points[0][0] - near.x, t.points[0][1] - near.y) < 15)?.points[0];
        if (!start) continue;
        if (Math.hypot(v.x - near.x, v.y - near.y) > Math.hypot(start[0] - near.x, start[1] - near.y)) p.fanout.out++; else p.fanout.in++;
      }
    }
    if (finite(o.spacing)) { const s = p.spacing; s.extra = r3((s.extra * s.samples + o.spacing) / (s.samples + 1)); s.samples++; }
    // Keep the profile small and recent: halve the counts past 400 routes.
    if (p.routes > 400) decay(p, 0.5);
    p.updated = new Date().toISOString().slice(0, 10);
    return true;
  }
  function decay(p, k) {
    p.routes = Math.round(p.routes * k);
    for (const c of Object.values(p.classes)) { c.routes = Math.round(c.routes * k); c.vias = Math.round(c.vias * k); for (const m of [c.layers, c.widths]) for (const x in m) m[x] = r3(m[x] * k); c.neck.seen = Math.round(c.neck.seen * k); c.neck.necked = Math.round(c.neck.necked * k); }
    for (const d of Object.values(p.dirs)) for (const x in d) d[x] = r3(d[x] * k);
    for (const m of [p.corners, p.exit, p.fanout]) for (const x in m) m[x] = Math.round(m[x] * k);
  }
  // The app's hook: an accepted suggestion or a hand-routed track (editor finishRoute).
  function observe(plan, board, defs, o = {}) {
    if (!enabled() || !plan || !board) return false;
    const project = o.project || globalThis.AtriumNavHost?.project?.();
    const p = load(project);
    if (!observeInto(p, board, defs, plan, {...o, project})) return false;
    save(project, p); return true;
  }
  // A profile from a board's existing copper, net by net (the evaluation harness, and the board's
  // own conventions when the user has no profile yet). `skip` leaves nets out.
  function fromBoard(board, defs, o = {}) {
    const p = empty(), by = new Map();
    for (const it of board.items) if ((it.kind === "track" || it.kind === "via") && it.net && !o.skip?.has(it.net)) { if (!by.has(it.net)) by.set(it.net, []); by.get(it.net).push(it); }
    for (const [, items] of by) observeInto(p, board, o.pads ? defs : null, {add: items}, {project: o.project, pads: !!o.pads, cls: o.classOf?.(items[0].net)});
    return p;
  }

  // ------------------------------------------------------------------ bias
  // Soft preferences for one net class on these layers, with the evidence for each, or {}.
  // Thresholds keep a handful of routes from steering anything.
  function bias(p, cls, layers, o = {}) {
    if (!p || !p.routes) return {};
    const out = {evidence: {}}, ev = out.evidence;
    const c = p.classes[cls] && p.classes[cls].routes >= 3 ? p.classes[cls] : null;
    const pool = c || merged(p);
    ev.cls = c ? (cls === "Default" ? null : cls) : null;
    // Layers: share of length on each available layer.
    const lens = layers.map(l => pool.layers[l] || 0), tot = lens.reduce((s, v) => s + v, 0);
    if (tot > 5 && pool.routes >= 3) {
      const mx = Math.max(...lens);
      out.layers = Object.fromEntries(layers.map((l, i) => [l, mx ? lens[i] / mx : 0]));
      ev.layers = pool.routes;
    }
    // Directions per layer: a clear majority of h or v.
    out.dirs = {};
    for (const l of layers) {
      const d = p.dirs[l]; if (!d) continue;
      const t = d.h + d.v + d.d; if (t < 10) continue;
      out.dirs[l] = d.h / t > 0.55 && d.h > 2 * d.v ? "h" : d.v / t > 0.55 && d.v > 2 * d.h ? "v" : "none";
    }
    // Vias per route: fewer than usual makes vias dearer.
    if (pool.routes >= 3) {
      const rate = pool.vias / pool.routes;
      out.viaScale = Math.max(0.6, Math.min(1.8, 1.4 - 0.5 * rate));
      ev.vias = pool.routes; ev.viaRate = Math.round(rate * 10) / 10;
    }
    // Corner style: a 75 % majority over at least 10 corners.
    const cs = p.corners, ct = cs["45"] + cs["90"] + cs.any + cs.arc;
    if (ct >= 10) {
      const top = Object.entries(cs).sort((a, b) => b[1] - a[1])[0];
      if (top[1] / ct >= 0.75) { out.corner = top[0] === "arc" ? "45arc" : top[0]; ev.corners = ct; }
    }
    // Width for the class: the most used, if it has most of the length.
    if (c) {
      const ws = Object.entries(c.widths).sort((a, b) => b[1] - a[1]), wt = ws.reduce((s, x) => s + x[1], 0);
      if (ws.length && ws[0][1] / wt >= 0.6) { out.width = +ws[0][0]; ev.widths = c.routes; }
      if (c.neck.seen >= 4 && c.neck.necked / c.neck.seen >= 0.5) { out.neckDown = true; ev.neck = c.neck.seen; }
    }
    // Pad exits along the long axis; vias fanned outward from the part.
    if (p.exit.long + p.exit.short >= 6 && p.exit.long / (p.exit.long + p.exit.short) >= 0.7 && o.exitAxis) { out.exitAxis = o.exitAxis; ev.exit = p.exit.long + p.exit.short; }
    if (p.fanout.out + p.fanout.in >= 6 && p.fanout.out / (p.fanout.out + p.fanout.in) >= 0.7 && o.fanCentre) { out.fanOut = true; out.fanCentre = o.fanCentre; ev.fan = p.fanout.out + p.fanout.in; }
    if (p.spacing.samples >= 5 && p.spacing.extra > 0.05) out.spacing = Math.min(3, 1 + p.spacing.extra * 4);
    return out;
  }
  function merged(p) {
    const m = {routes: 0, vias: 0, layers: {}, widths: {}};
    for (const c of Object.values(p.classes)) { m.routes += c.routes; m.vias += c.vias; for (const [k, v] of Object.entries(c.layers)) m.layers[k] = (m.layers[k] || 0) + v; }
    return m;
  }

  // ------------------------------------------------------------------ text
  // One line per learned preference, for Preferences and the suggestion chip.
  function describe(p) {
    if (!p?.routes) return ["Nothing learned yet. Accept suggestions or route by hand and your habits appear here."];
    const out = ["Learned from " + p.routes + " route" + (p.routes === 1 ? "" : "s") + (p.updated ? " (last " + p.updated + ")" : "") + "."];
    for (const [cls, c] of Object.entries(p.classes)) {
      const ls = Object.entries(c.layers).sort((a, b) => b[1] - a[1]), t = ls.reduce((s, x) => s + x[1], 0);
      const ws = Object.entries(c.widths).sort((a, b) => b[1] - a[1]);
      out.push(cls + ": " + c.routes + " routes; layers " + ls.slice(0, 3).map(([l, v]) => l + " " + Math.round(100 * v / (t || 1)) + "%").join(", ") +
        (ws.length ? "; width " + ws[0][0] + " mm" : "") + "; " + (c.routes ? (c.vias / c.routes).toFixed(1) : "0") + " vias per route" + (c.neck.seen ? "; necks down at " + c.neck.necked + "/" + c.neck.seen + " small pads" : ""));
    }
    const dirs = Object.entries(p.dirs).map(([l, d]) => { const t = d.h + d.v + d.d || 1; return l + " " + Math.round(100 * d.h / t) + "% horizontal, " + Math.round(100 * d.v / t) + "% vertical"; });
    if (dirs.length) out.push("Directions: " + dirs.join("; ") + ".");
    const cs = p.corners, ct = cs["45"] + cs["90"] + cs.any + cs.arc;
    if (ct) out.push("Corners: " + Math.round(100 * cs["45"] / ct) + "% 45°, " + Math.round(100 * cs["90"] / ct) + "% 90°, " + Math.round(100 * cs.arc / ct) + "% arcs.");
    if (p.exit.long + p.exit.short) out.push("Pad exits: " + p.exit.long + " along the long side, " + p.exit.short + " from the short side.");
    if (p.fanout.out + p.fanout.in) out.push("Fanout vias: " + p.fanout.out + " outward, " + p.fanout.in + " inward.");
    if (p.spacing.samples) out.push("Spacing: " + p.spacing.extra + " mm beyond the clearance rule on average.");
    return out;
  }
  const exportText = p => JSON.stringify(p, null, 2);
  function importText(text) { const p = clean(JSON.parse(text)); if (p.format !== FORMAT) throw Error("This is not a Waffle routing habits file."); return p; }

  // Preferences › Route Suggestions (self-registered, as camera.js does, so prefs.js stays small):
  // the switches, the Tab policy, and the learned profile with Reset, Export and Import.
  const PREF_DEFAULTS = Object.freeze({"routing.suggest": true, "routing.suggestOn": "hover", "routing.suggestTab": "ghost", "routing.suggestNext": true, "routing.habits": false, "routing.habitsScope": "user"});
  const ROWS = [
    ["routing.suggest", "Suggest routes (ghost completions)", "Preview a rule-checked route as you work."],
    ["routing.suggestOn", "Show suggestions", "Include previews while hovering.", [["hover", "On hover and while routing"], ["start", "Only after starting a route"]]],
    ["routing.suggestTab", "Tab key", "Accept a preview or open properties.", [["ghost", "Accepts a shown suggestion"], ["altium", "Always routing properties (Altium)"]]],
    ["routing.suggestNext", "Suggest the next connection after accepting", null],
    ["routing.habits", "Learn my routing habits", "Learn from your routes while respecting design rules."],
    ["routing.habitsScope", "Keep habits", null, [["user", "For me, across projects"], ["project", "Per project"]]]
  ];
  function renderPage(c, P, {el, group}) {
    const status = (msg, bad) => { const s = c.closest?.("dialog")?.querySelector?.(".prf-status"); if (s) { s.textContent = msg || ""; if (bad) s.dataset.tone = "danger"; else delete s.dataset.tone; } };
    const g = group(c, "Route Suggestions");
    for (const [key, label, help, options] of ROWS) {
      const id = "prf-" + key.replace(/\W/g, "-"), wrap = el("div", "prf-row"), cur = pref(key, PREF_DEFAULTS[key]);
      wrap.dataset.search = (label + " " + (help || "") + " " + key + " suggest suggestion ghost tab habits").toLowerCase();
      let input;
      if (!options) {
        wrap.classList.add("prf-check"); input = el("input", "ui-switch"); input.type = "checkbox"; input.setAttribute("role", "switch"); input.checked = cur !== false; input.id = id;
        input.onchange = () => { try { P.set(key, input.checked); status(""); } catch (e) { status(e.message, true); } };
        const l = el("label", "ui-switch-row"); l.htmlFor = id; l.append(input, el("span", null, label)); wrap.append(l);
      } else {
        const l = el("label", "prf-label", label); l.htmlFor = id; input = el("select", "ui-field"); input.id = id;
        for (const [v, t] of options) { const o = el("option", null, t); o.value = v; input.append(o); }
        input.value = String(cur); input.onchange = () => { try { P.set(key, input.value); status(""); } catch (e) { status(e.message, true); } };
        const ctl = el("span", "prf-control"); ctl.append(input); wrap.append(l, ctl);
      }
      if (help) {
        const h = el("small", "prf-help", help); h.id = id + "-help"; input.setAttribute("aria-describedby", h.id); wrap.append(h);
        if (key === "routing.suggestTab") {
          const K = globalThis.AtriumKeymap;
          const extra = K?.bindingsFor("route-suggest-accept").find(binding => binding.key !== "Tab" && !binding.when)?.key;
          if (extra) h.append(" ", AtriumShortcut.render(extra, {variant:"inline"}));
        }
      }
      g.append(wrap);
    }
    const habits = group(c, "Learned habits");
    renderProfile(habits, {status});
  }
  function renderProfile(container, o = {}) {
    const d = globalThis.document; if (!d || !container) return;
    const project = globalThis.AtriumNavHost?.project?.();
    const box = d.createElement("div"); box.className = "rs-habits"; box.dataset.search = "habits learned profile reset export import privacy";
    const list = d.createElement("ul"); list.className = "rs-habits-list";
    const fill = () => { list.textContent = ""; for (const line of describe(load(project))) { const li = d.createElement("li"); li.textContent = line; list.append(li); } };
    fill();
    const bar = d.createElement("div"); bar.className = "prf-inline-actions";
    const btn = (text, fn, title) => { const b = d.createElement("button"); b.type = "button"; b.className = "ui-button"; b.textContent = text; if (title) b.title = title; b.onclick = fn; bar.append(b); return b; };
    btn("Reset habits", () => { reset(project); fill(); o.status?.("Routing habits reset to the defaults."); }, "Forget everything learned; suggestions go back to the rule defaults.");
    btn("Export…", () => { (globalThis.AtriumIO?.exportFile || (() => {}))("routing-habits.json", exportText(load(project))); }, "Save the profile as a JSON file (it is not part of the project).");
    btn("Import…", async () => {
      try { const f = await globalThis.AtriumIO?.pickFile?.(".json"); const text = f?.text ? await f.text() : typeof f === "string" ? f : null; if (!text) return; save(project, importText(text)); fill(); o.status?.("Routing habits imported."); }
      catch (e) { o.status?.(e.message, true); }
    }, "Load a profile exported earlier.");
    const note = d.createElement("p"); note.className = "prf-note";
    note.textContent = "Stored only in this browser's local storage (" + (scope() === "project" ? "for this project" : "for you, across projects") + "). Never sent anywhere and never saved in the project file unless you export it. Rules always win: habits only choose among routes that pass every design rule.";
    box.append(list, bar, note); container.append(box);
    onChange(fill);
  }
  function registerPage() {
    const P = globalThis.AtriumPrefs; if (!P?.registerPage || !globalThis.document) return null;
    return P.registerPage({id: "route-suggestions", title: "Route Suggestions", order: 2.6, keywords: "route suggestion suggestions ghost autocomplete tab accept habits learn profile privacy", render: (c, api) => renderPage(c, P, api)});
  }
  function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
  registerPage();
  return Object.freeze({FORMAT, VERSION, empty, clean, load, save, reset, observe, observeInto, fromBoard, bias, describe, exportText, importText, renderProfile, registerPage, PREF_DEFAULTS, onChange, classOf, enabled, keyFor});
})();
