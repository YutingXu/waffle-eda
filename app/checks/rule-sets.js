"use strict";
// Design rule sets (Design › Rule Sets…): named, reusable sets of design rules.
// A rule set is a complete version 2 rule set (rules.js) with a name. Sets are
// kept in the project (project.ruleSets) and move between projects as JSON
// files; the active set of a board is copied into board.rules, so the rule
// engine, routers and exporters keep reading the board rules as before.
//
// project.ruleSets = {version:1, sets:[SET...], active?:{[boardId]: name}}
// SET  = {name, description?, approximate?, source?, rules:{format:"atrium-rules", version:2, ...}}
// File = {format:"atrium-rule-set", version:1, ...SET}   (a .waffle-rules.json file)
//
// Import is data only: the file is parsed as JSON (nothing is evaluated), every
// key is checked against this schema, prototype keys are refused, and the rules
// must pass AtriumRules.validate. A plain rules file (format "atrium-rules") is
// accepted too and named after the file.
//
// Starter sets come from the fab profiles (fab-profiles.js) and are marked
// approximate, like the profiles they summarise.
globalThis.AtriumRuleSets = (() => {
  const FORMAT = "atrium-rule-set", VERSION = 1, MAX_TEXT = 8 * 1024 * 1024, MAX_SETS = 200;
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const fail = m => { throw Error(m); };
  const R = () => globalThis.AtriumRules || fail("Design rules are unavailable in this build.");
  const validName = s => typeof s === "string" && !!s.trim() && s === s.trim() && s.length <= 128 && !/[\u0000-\u001f]/.test(s);
  const clone = v => JSON.parse(JSON.stringify(v));
  const APPROX = "Approximate values derived from a fab profile. Verify with the fab's current capability page before ordering.";
  // Starter sets: [set name, fab profile id, extra rules].
  // JLC starters are the sourced fab presets (fab-profiles.js reads app/fab-presets/jlcpcb.json).
  const STARTERS = [["JLC 2-layer", "jlcpcb-2l"], ["JLC 4-layer", "jlcpcb-4l"], ["PCBWay standard", "pcbway-standard"]];
  const SET_KEYS = ["name", "description", "approximate", "source", "rules"];

  // ---------------------------------------------------------------- schema
  function checkSet(set, where = "The rule set") {
    if (!plain(set)) fail(where + " must be an object.");
    for (const k of Object.keys(set)) if (!SET_KEYS.includes(k)) fail(where + " contains the unsupported setting " + k + ".");
    if (!validName(set.name)) fail(where + " needs a name of up to 128 characters.");
    if (set.description != null && (typeof set.description !== "string" || set.description.length > 4000)) fail(set.name + ": the description must be text of up to 4000 characters.");
    if (set.approximate != null && typeof set.approximate !== "boolean") fail(set.name + ": approximate must be true or false.");
    if (set.source != null && (typeof set.source !== "string" || set.source.length > 256)) fail(set.name + ": the source must be text of up to 256 characters.");
    if (!plain(set.rules)) fail(set.name + " has no rules.");
    try { R().validate(set.rules); } catch (e) { fail(set.name + ": " + e.message); }
    return set;
  }
  // A clean, normalised copy of a set.
  function cleanSet(input) {
    const {builtin, ...set} = plain(input) ? input : {name: null};
    checkSet(set);
    const out = {name: set.name, rules: R().migrate(clone(set.rules))};
    if (set.description) out.description = set.description;
    if (set.approximate) out.approximate = true;
    if (set.source) out.source = set.source;
    return out;
  }
  // project.ruleSets, checked by model.validate when this module is loaded.
  function validateStore(store) {
    if (!plain(store) || store.version !== VERSION) fail("Rule sets must be stored as version 1.");
    for (const k of Object.keys(store)) if (!["version", "sets", "active"].includes(k)) fail("The rule set store contains the unsupported setting " + k + ".");
    if (!Array.isArray(store.sets) || store.sets.length > MAX_SETS) fail("Rule sets must be a list of up to " + MAX_SETS + ".");
    const names = new Set();
    for (const s of store.sets) {
      checkSet(s);
      const k = s.name.toLowerCase();
      if (names.has(k)) fail("Rule set names must be unique. " + s.name + " is used twice.");
      names.add(k);
    }
    if (store.active != null) {
      if (!plain(store.active)) fail("Active rule sets must map boards to set names.");
      for (const [id, name] of Object.entries(store.active)) if (typeof id !== "string" || !validName(name)) fail("Active rule sets must map boards to set names.");
    }
    return store;
  }
  // Forward compatibility (app/compat.js): only for project.ruleSets in a file that claims a newer minor
  // format. In place, takes out store and set keys this build doesn't know, and what AtriumRules.setAside
  // takes out of each set's rules; returns {keys, order, sets: {lower-case name: {keys, order, rules}}} or null.
  function setAside(store) {
    if (!plain(store) || store.version !== VERSION) return null;
    const split = (o, allowed) => { const keys = {}; let n = 0; for (const k of Object.keys(o)) if (!allowed.includes(k)) { keys[k] = o[k]; n++; }
      if (!n) return null; const order = Object.keys(o); for (const k in keys) delete o[k]; return {keys, order}; };
    const rec = /** @type {any} */(split(store, ["version", "sets", "active"]) || {});
    if (Array.isArray(store.sets)) for (const set of store.sets) {
      if (!plain(set) || typeof set.name !== "string") continue;
      const x = /** @type {any} */(split(set, SET_KEYS) || {}), rules = plain(set.rules) && typeof R()?.setAside === "function" ? R().setAside(set.rules) : null;
      if (rules) x.rules = rules;
      if (Object.keys(x).length) (rec.sets ||= {})[set.name.toLowerCase()] = x;
    }
    return Object.keys(rec).length ? rec : null;
  }
  // JSON.parse that refuses prototype keys and deep nesting.
  function parse(text) {
    if (typeof text !== "string") fail("Choose a rule set file.");
    if (text.length > MAX_TEXT) fail("The rule set file is too large.");
    let depth = 0, max = 0;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 123 || c === 91) { depth++; if (depth > max) max = depth; } else if (c === 125 || c === 93) depth--; }
    if (max > 32) fail("The rule set file is nested too deeply.");
    let data;
    try {
      data = JSON.parse(text, (k, v) => { if (k === "__proto__" || k === "constructor" || k === "prototype") throw Error("forbidden key " + k); return v; });
    } catch (e) { fail("This is not a valid rule set file: " + e.message.replace(/^JSON\.parse: /, "") + "."); }
    return data;
  }
  // importText(text, fileName?) -> [cleaned sets]
  function importText(text, fileName = "") {
    const data = parse(text);
    if (plain(data) && data.format === "atrium-rules") {
      const base = String(fileName).replace(/^.*[\\/]/, "").replace(/(\.waffle-rules)?\.json$|\.waffle-rules$/i, "").trim().slice(0, 128) || "Imported rules";
      return [cleanSet({name: base, rules: data})];
    }
    if (!plain(data) || data.format !== FORMAT) fail("Choose a Waffle rule set file (format " + FORMAT + ").");
    if (data.version !== VERSION) fail("This rule set file is version " + data.version + "; this build reads version " + VERSION + ".");
    if (Array.isArray(data.sets)) {
      for (const k of Object.keys(data)) if (!["format", "version", "sets"].includes(k)) fail("The rule set file contains the unsupported setting " + k + ".");
      if (!data.sets.length || data.sets.length > MAX_SETS) fail("The rule set file has no sets.");
      return data.sets.map((s, n) => cleanSet(s, "Set " + (n + 1)));
    }
    const {format, version, ...set} = data;
    return [cleanSet(set)];
  }
  function exportText(sets) {
    const list = (Array.isArray(sets) ? sets : [sets]).map(cleanSet);
    const head = {format: FORMAT, version: VERSION};
    return JSON.stringify(list.length === 1 ? {...head, ...list[0]} : {...head, sets: list}, null, 2) + "\n";
  }

  // ---------------------------------------------------------------- starter sets
  let starterCache = null;
  function starters() {
    const F = globalThis.AtriumFabProfiles;
    if (!F || !globalThis.AtriumRules) return [];
    if (starterCache) return starterCache.map(clone);
    const out = [];
    for (const [name, id] of STARTERS) {
      const p = F.get(id);
      if (!p) continue;
      const res = F.applyProfile(null, id, {rules: R().create(), templates: false});
      const rules = res.rules;
      if (p.edgeClearance > 0 && R().types.boardOutlineClearance && !rules.list.some(r => r.type === "boardOutlineClearance"))
        rules.list.push({id: "fab-" + p.id + "-boardOutlineClearance", type: "boardOutlineClearance", name: ((p.short || p.name) + " – Board Outline Clearance").slice(0, 128),
          comment: "From fab profile " + p.name + ". " + F.APPROX, enabled: true, priority: 1, scope: globalThis.AtriumDesignQueryRecord.selector("all"), gap: p.edgeClearance});
      const dfa = R().types.dfaSpacing;
      if (dfa) { const r = {id: "fab-" + p.id + "-dfaSpacing", type: "dfaSpacing", name: "DFA Spacing", comment: "Starter assembly spacing matrix (package type pairs).", enabled: true, priority: 1, scope: globalThis.AtriumDesignQueryRecord.selector("all")};
        for (const f of dfa.fields) r[f.key] = clone(f.def); rules.list.push(r); }
      for (const rule of rules.list) rule.presetKey ??= R().presetRuleKey(rule) ?? "ruleset-" + id + "-" + rule.id;
      out.push({name, description: p.name + ": " + APPROX, approximate: true, source: "fab-profile:" + p.id, rules: R().normalize(rules), builtin: true});
    }
    starterCache = out;
    return out.map(clone);
  }

  // ---------------------------------------------------------------- project store
  const store = (project, create) => {
    if (!project.ruleSets && create) project.ruleSets = {version: VERSION, sets: []};
    return project.ruleSets || null;
  };
  const presetSlot = (rule, key) => JSON.stringify([rule.set ?? "Default", rule.type, key]);
  const templateKey = rule => R().presetRuleKey(rule) ?? "ruleset-" + rule.id + "-";
  function rulesByPreset(rules) {
    const slots = new Map();
    for (const r of rules?.list ?? []) {
      const key = R().presetRuleKey(r);
      if (!key) continue;
      const slot = presetSlot(r, key);
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(r);
    }
    return slots;
  }
  // User sets first, then starter sets not shadowed by a user set of the same name.
  function list(project) {
    const user = (project?.ruleSets?.sets || []).map(s => ({...clone(s), builtin: false}));
    const names = new Set(user.map(s => s.name.toLowerCase()));
    return [...user, ...starters().filter(s => !names.has(s.name.toLowerCase()))];
  }
  const get = (project, name) => list(project).find(s => s.name.toLowerCase() === String(name || "").toLowerCase()) || null;
  // Save (add or replace) a user set; returns the stored set.
  function save(project, set) {
    const clean = cleanSet(set), previous = store(project, false)?.sets ?? [];
    const i = previous.findIndex(x => x.name.toLowerCase() === clean.name.toLowerCase());
    if (i < 0 && previous.length >= MAX_SETS) fail("A project holds at most " + MAX_SETS + " rule sets.");
    const prior = previous[i]?.rules, ids = new Set(prior?.list.map(r => r.id)), slots = rulesByPreset(prior);
    const retain = r => ids.has(r.id) || globalThis.AtriumUUID.isV7(r.id);
    const used = new Set(clean.rules.list.filter(retain).map(r => r.id));
    for (const r of clean.rules.list) {
      if (retain(r)) continue;
      const key = templateKey(r);
      const old = slots.get(presetSlot(r, key))?.find(r => !used.has(r.id));
      r.id = old?.id ?? globalThis.Atrium.id();
      r.presetKey = old ? old.presetKey : key;
      used.add(r.id);
    }
    const s = store(project, true);
    if (i >= 0) s.sets[i] = clean; else s.sets.push(clean);
    return clean;
  }
  function remove(project, name) {
    const s = store(project, false);
    if (!s) return false;
    const before = s.sets.length;
    s.sets = s.sets.filter(x => x.name.toLowerCase() !== String(name).toLowerCase());
    for (const [id, n] of Object.entries(s.active || {})) if (n.toLowerCase() === String(name).toLowerCase()) delete s.active[id];
    if (s.active && !Object.keys(s.active).length) delete s.active;
    if (!s.sets.length && !s.active) delete project.ruleSets;
    return s.sets.length !== before;
  }
  // The board's current rules as a set.
  function fromBoard(project, doc, name, meta = {}) {
    return cleanSet({...meta, name, rules: R().effective(doc, project)});
  }
  // Rules for running a set on a board. Net classes, differential pairs and
  // currents belong to the design: a set without them keeps the board's own.
  const DESIGN_KEYS = ["netClasses", "diffPairs", "diffPairClasses", "netCurrents", "classCurrents"];
  function rulesFor(project, doc, name) {
    const set = typeof name === "object" && name ? name : get(project, name);
    if (!set) fail("No rule set is named " + name + ".");
    const current = R().effective(doc, project), rules = clone(set.rules);
    for (const k of DESIGN_KEYS) if (rules[k] == null && current[k] != null) rules[k] = clone(current[k]);
    // Scopes may name classes the set does not define; keep the rules valid.
    const out = R().normalize(rules);
    R().validate(out);
    return out;
  }
  // Make a set the board's rules and remember it as active.
  function activate(project, doc, name) {
    const set = get(project, name);
    if (!set) fail("No rule set is named " + name + ".");
    const current = R().effective(doc, project), slots = rulesByPreset(current);
    const ids = new Map(current.list.map(r => [r.id, r])), used = new Set();
    const rules = rulesFor(project, doc, set);
    for (const r of rules.list) {
      const key = templateKey(r), sameId = ids.get(r.id);
      const old = sameId?.type === r.type && sameId.set === r.set && !used.has(sameId.id) ? sameId :
        slots.get(presetSlot(r, key))?.find(r => !used.has(r.id));
      r.id = old?.id ?? globalThis.Atrium.id();
      r.presetKey = old && project.rules ? old.presetKey : key;
      used.add(r.id);
    }
    R().store(doc, project, rules);
    const s = store(project, true);
    s.active = {...(s.active || {}), [doc.id]: set.name};
    return set;
  }
  // Compare constraint content and order independently of template and board identities.
  const fingerprint = rules => {
    try {
      const m = R().migrate(clone(rules));
      return JSON.stringify(m.list.map(({id, presetKey, ...r}) => r).sort((a, b) => (a.type + a.name < b.type + b.name ? -1 : 1)));
    } catch { return null; }
  };
  // {name, modified, approximate} for the board's active set, or null.
  function active(project, doc) {
    const name = project?.ruleSets?.active?.[doc?.id];
    if (!name) return null;
    const set = get(project, name);
    if (!set) return {name, modified: true, missing: true, approximate: false};
    return {name: set.name, modified: fingerprint(set.rules) !== fingerprint(R().effective(doc, project)), approximate: !!set.approximate};
  }
  // "JLC 2-layer (approximate)", "Mine (modified)" or "" for reports.
  function label(project, doc) {
    let a = null;
    try { a = active(project, doc); } catch { a = null; }
    if (!a) return "";
    return a.name + (a.modified ? " (modified)" : a.approximate ? " (approximate)" : "");
  }

  // ---------------------------------------------------------------- dialog
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, cls, title) { const b = el("button", text, cls); b.classList.add("ui-button"); if (cls === "vs-danger") b.dataset.variant = "danger"; b.type = "button"; b.onclick = act; if (title) b.title = title; return b; }
  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") { ctx.info?.("Open a board layout to choose a rule set."); return null; }
    document.querySelectorAll("dialog.rset-dialog").forEach(x => x.close());
    const project = () => ctx.currentProject?.() || ctx.project, board = () => project().documents.find(d => d.id === doc.id) || doc;
    let selected = active(project(), board())?.name || list(project())[0]?.name || null;
    const d = el("dialog", null, "ui-dialog work-dialog rset-dialog", {"aria-label": "Design rule sets"});
    const head = el("div", null, "rset-head"), sub = el("p", null, "rset-sub");
    head.append(el("h2", "Design Rule Sets", "ui-dialog-title"), sub);
    const items = el("div", null, "ui-list rset-items", {role: "listbox", "aria-label": "Rule sets"}), detail = el("div", null, "rset-detail");
    const status = el("p", null, "rset-status", {role: "status", "aria-live": "polite"});
    const body = el("div", null, "rset-body ui-dialog-body"); body.append(items, detail);
    const tools = el("div", null, "work-toolbar rset-tools");
    const say = t => { status.textContent = t; };
    const safe = fn => async () => { try { await fn(); } catch (e) { say(e.message); } };
    tools.append(
      button("Save board rules as…", safe(() => {
        const name = globalThis.prompt?.("Rule set name", (board().name || "Board") + " rules");
        if (!name) return;
        ctx.edit(() => save(project(), fromBoard(project(), board(), name.trim())));
        selected = name.trim(); paint(); say("Saved rule set " + selected + ".");
      }), "", "Store the board's current rules as a named set in this project"),
      button("Import…", safe(async () => {
        const f = ctx.pickFile ? await ctx.pickFile([".json", ".waffle-rules"]) : null;
        if (!f) return;
        const text = f.text ? await f.text() : new TextDecoder().decode(await f.arrayBuffer());
        const got = importText(text, f.name || "");
        ctx.edit(() => { for (const s of got) save(project(), s); });
        selected = got[0].name; paint(); say(got.length + " rule set" + (got.length === 1 ? "" : "s") + " imported.");
      }), "", "Import rule sets from a JSON file"),
      button("Export…", safe(async () => {
        const s = get(project(), selected);
        if (!s) return;
        const {builtin, ...plainSet} = s;
        await ctx.exportFile?.(s.name.replace(/[\\/:*?"<>|]/g, "-") + ".waffle-rules.json", exportText(plainSet));
      }), "", "Export the selected set as JSON"),
      button("Delete", safe(() => {
        const s = get(project(), selected);
        if (!s || s.builtin) { say("Starter sets cannot be deleted."); return; }
        ctx.edit(() => remove(project(), s.name));
        selected = list(project())[0]?.name || null; paint(); say("Deleted " + s.name + ".");
      }), "vs-danger"));
    const footer = el("div", null, "work-actions ui-dialog-actions");
    const addToBoard = globalThis.AtriumRuleGroups ? button("Add to board", safe(() => {
      const s = selected && get(project(), selected);
      if (!s) return;
      let x = null;
      ctx.edit(() => { x = AtriumRuleGroups.edit(board(), project(), r => AtriumRuleGroups.addSet(r, s)); });
      paint(); say(x.set.name + " added to the board as a rule set (" + x.rules + " rules). Disable it in Sets on this board to stop checking it.");
    }), "", "Add the selected set's rules to this board as a separate rule set") : null;
    const makeActive = button("Make active", safe(() => {
      if (!selected) return;
      ctx.edit(() => activate(project(), board(), selected));
      paint(); say(selected + " is now the active rule set of " + (board().name || "the board") + ". Run the design rule check to see its violations.");
    }), "", "Copy the selected set into the board rules");
    makeActive.dataset.variant = "primary";
    const close = button("Close", () => d.close());
    footer.append(close, ...(addToBoard ? [addToBoard] : []), makeActive);
    // Board rule sets (rule-groups.js) above the library of reusable sets.
    const groups = globalThis.AtriumRuleGroups?.section({ctx, project, board, say, onChange: () => paint()}) || null;
    d.append(head, ...(groups ? [groups, el("h3", "Library sets", "rset-lib")] : []), tools, body, status, footer);
    d.addEventListener("close", () => d.remove(), {once: true});
    d.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); d.close(); } });
    items.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const rows = [...items.querySelectorAll('[role="option"]')];
      const at = rows.indexOf(e.target.closest('[role="option"]'));
      if (at < 0) return;
      const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) :
        e.key === "ArrowUp" ? Math.max(0, at - 1) : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault();
      rows[next].click();
    });
    function paint() {
      groups?.refresh?.();
      const refocus = items.contains(document.activeElement);
      const sets = list(project()), act = active(project(), board());
      sub.textContent = (board().name || "Board") + " · active: " + (act ? label(project(), board()) : "none (board rules)");
      items.replaceChildren();
      let group = null;
      for (const s of sets) {
        const g = s.builtin ? "Starter sets (approximate)" : "Project sets";
        if (g !== group) { items.append(el("div", g, "rset-group")); group = g; }
        // A library list row: the set's name, and whether it is the active set as the meta.
        const row = el("div", null, "ui-row rset-row", {role: "option", tabindex: s.name === selected ? "0" : "-1", "aria-selected": String(s.name === selected)}), text = el("span", null, "ui-row-text");
        text.append(el("span", s.name, "ui-row-title"));
        row.append(text, act?.name === s.name ? el("span", act.modified ? "active · modified" : "active", "ui-row-meta") : el("span", ""));
        row.onclick = () => { selected = s.name; paint(); };
        row.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selected = s.name; paint(); } };
        items.append(row);
      }
      // Keep one Tab stop in the list and restore focus after replacing its rows.
      const current = items.querySelector('[aria-selected="true"]') || items.querySelector("[role=option]");
      if (current) current.tabIndex = 0;
      if (refocus) current?.focus();
      detail.replaceChildren();
      const s = sets.find(x => x.name === selected);
      if (!s) { detail.append(el("p", "No rule sets yet. Save the board rules or import a set.")); return; }
      detail.append(el("h3", s.name));
      if (s.approximate) { // a library warning notice
        const n = el("div", null, "ui-notice rset-warning", {role: "note", "data-tone": "warning"});
        n.append(el("span", null, "ui-dot", {"data-tone": "warning"}), el("div", "Approximate: derived from a fab profile. Check the fab's current capabilities before ordering.", "ui-notice-text"));
        detail.append(n);
      }
      if (s.description) detail.append(el("p", s.description));
      const table = el("table", null, "rules-table"), tbody = el("tbody"), hr = el("tr");
      for (const h of ["Rule", "Type", "Constraint"]) hr.append(el("th", h, null, {scope: "col"}));
      const thead = el("thead"); thead.append(hr); table.append(thead, tbody);
      for (const r of s.rules.list) {
        const tr = el("tr");
        tr.append(el("td", r.name), el("td", R().types[r.type]?.title || r.type), el("td", R().constraintText(r, "mm")));
        tbody.append(tr);
      }
      const wrap = el("div", null, "rules-table-wrap"); wrap.append(table); detail.append(wrap);
    }
    document.body.append(d); paint(); globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: () => items.querySelector('[tabindex="0"]') || close, defaultAction: false}); d.showModal();
    // Start in the list of sets, not on the first toolbar button.
    (items.querySelector('[tabindex="0"]') || close)?.focus();
    return d;
  }

  return Object.freeze({FORMAT, VERSION, APPROX, checkSet, cleanSet, validateStore, setAside, importText, exportText, starters, list, get, save, remove,
    fromBoard, rulesFor, activate, active, label, open});
})();
