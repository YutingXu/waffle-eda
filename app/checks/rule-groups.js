"use strict";
// Board rule sets (Altium 26 "Design Rule Sets"): the rules of one board are grouped into
// named sets that can be created, duplicated, renamed, enabled or disabled, deleted, imported
// and exported. Disabled sets are not checked (batch and online DRC) and routers do not use
// them; priorities stay global, so the rule that wins among the enabled sets is the same one
// that would win with every set enabled. DRC violations, the DRC report, the Messages panel
// and MCP name the set a rule came from.
//
// Stored in the board rules (rules.js, format 1.3):
//   rules.ruleSets = [{name, enabled, description?}]   ("Default" holds rules without a set)
//   rule.set       = set name (omitted for the Default set)
// A board without rules.ruleSets has every rule in the enabled Default set, exactly as before.
//
// Library sets (project.ruleSets, rule-sets.js) are reusable templates; "Add to board" turns
// one into a board set. Files use the rule-set file format of rule-sets.js
// ({format:"atrium-rule-set", version:1, name, rules}), so one export can be imported either
// as a board set or as a library set.
//
//   AtriumRuleGroups.list(rules)                       -> [{name, enabled, description, count, isDefault}]
//   create / duplicate / setEnabled / rename / remove / assign / addSet / importText / exportText
//   AtriumRuleGroups.edit(doc, project, fn)            -> runs fn(rules) on the board rules, stores them normalised
//   AtriumRuleGroups.headless(project, doc, a)         -> MCP command board_rule_sets
//   AtriumRuleGroups.section(o)                        -> the "Sets on this board" part of Design › Rule Sets…
globalThis.AtriumRuleGroups = (() => {
  const DEFAULT = "Default", MAX = 200;
  const fail = m => { throw Error(m); };
  const R = () => globalThis.AtriumRules || fail("Design rules are unavailable in this build.");
  const lower = s => String(s || "").toLowerCase();
  const setOf = r => r?.set || DEFAULT;
  const clone = v => JSON.parse(JSON.stringify(v));
  const validName = s => typeof s === "string" && !!s.trim() && s === s.trim() && s.length <= 128 && !/[\u0000-\u001f]/.test(s);
  const newId = () => globalThis.Atrium.id();

  function ensure(rules) {
    if (!Array.isArray(rules.ruleSets) || !rules.ruleSets.length) rules.ruleSets = [{name: DEFAULT, enabled: true}];
    if (!rules.ruleSets.some(s => lower(s.name) === lower(DEFAULT))) rules.ruleSets.unshift({name: DEFAULT, enabled: true});
    return rules.ruleSets;
  }
  const find = (rules, name) => (rules.ruleSets || []).find(s => lower(s.name) === lower(name)) || null;
  function need(rules, name) {
    if (lower(name) === lower(DEFAULT) && !find(rules, DEFAULT)) ensure(rules);
    return find(rules, name) || fail("The board has no rule set named " + name + ".");
  }
  function list(rules) {
    const counts = new Map();
    for (const r of rules.list || []) counts.set(lower(setOf(r)), (counts.get(lower(setOf(r))) || 0) + 1);
    const sets = rules.ruleSets?.length ? rules.ruleSets : [{name: DEFAULT, enabled: true}];
    return sets.map(s => ({name: s.name, enabled: s.enabled !== false, description: s.description || "", count: counts.get(lower(s.name)) || 0, isDefault: lower(s.name) === lower(DEFAULT)}));
  }
  function checkNew(rules, name) {
    if (!validName(name)) fail("A rule set needs a name of up to 128 characters without leading or trailing spaces.");
    if (find(rules, name) || (!rules.ruleSets?.length && lower(name) === lower(DEFAULT))) fail("A rule set named " + name + " already exists.");
    if ((rules.ruleSets?.length || 1) >= MAX) fail("A board holds at most " + MAX + " rule sets.");
  }
  function create(rules, name, o = {}) {
    checkNew(rules, name);
    ensure(rules);
    const s = {name, enabled: o.enabled !== false};
    if (o.description) s.description = String(o.description).slice(0, 4000);
    rules.ruleSets.push(s);
    return s;
  }
  // A rule name not used yet: "Clearance (Copy)", "Clearance (Copy) 2", …
  function uniqueName(rules, base, taken) {
    const used = taken || new Set((rules.list || []).map(r => lower(r.name)));
    let n = base.slice(0, 128), k = 2;
    while (used.has(lower(n))) n = (base.slice(0, 120) + " " + k++).slice(0, 128);
    used.add(lower(n));
    return n;
  }
  // Copies of rules join the end of each type's priority order, so existing rules keep
  // their precedence over them.
  function addRules(rules, incoming, setName, suffix) {
    const taken = new Set((rules.list || []).map(r => lower(r.name)));
    const lowest = new Map();
    for (const r of rules.list) lowest.set(r.type, Math.max(lowest.get(r.type) || 0, r.priority || 0));
    const added = [];
    for (const src of incoming.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0))) {
      if (!R().types[src.type]) continue;
      const {label, m1, m2, set, ...plainRule} = src;
      const r = {...clone(plainRule), id: newId(), name: uniqueName(rules, src.name, taken)};
      if (suffix && lower(r.name) !== lower(src.name)) r.name = uniqueName(rules, (src.name + " (" + suffix + ")").slice(0, 128), taken);
      r.priority = (lowest.get(r.type) || 0) + 1; lowest.set(r.type, r.priority);
      if (lower(setName) !== lower(DEFAULT)) r.set = setName; else delete r.set;
      rules.list.push(r); added.push(r);
    }
    return added;
  }
  function freeName(rules, base) {
    let n = base.slice(0, 128), k = 2;
    while (find(rules, n) || (!rules.ruleSets?.length && lower(n) === lower(DEFAULT))) n = (base.slice(0, 120) + " " + k++).slice(0, 128);
    return n;
  }
  // The copy starts disabled (both enabled would report every violation twice); enable it to switch.
  function duplicate(rules, name, newName, o = {}) {
    const from = need(rules, name), to = newName ? newName : freeName(rules, from.name + " copy");
    const copy = create(rules, to, {enabled: o.enabled === true, description: from.description});
    addRules(rules, rules.list.filter(r => lower(setOf(r)) === lower(from.name)), copy.name, copy.name);
    return copy;
  }
  function setEnabled(rules, name, on) { const s = need(rules, name); s.enabled = !!on; return s; }
  function rename(rules, name, next) {
    const s = need(rules, name);
    if (lower(s.name) === lower(DEFAULT)) fail("The Default set holds rules without a set and keeps its name.");
    if (lower(next) !== lower(s.name)) checkNew(rules, next);
    else if (!validName(next)) fail("A rule set needs a name.");
    for (const r of rules.list) if (lower(r.set) === lower(s.name)) r.set = next;
    s.name = next;
    return s;
  }
  // keepRules: the set's rules move to Default; otherwise they are deleted with it.
  function remove(rules, name, o = {}) {
    const s = need(rules, name);
    if (lower(s.name) === lower(DEFAULT)) fail("The Default set cannot be deleted. Disable it instead.");
    const mine = r => lower(r.set) === lower(s.name);
    const n = rules.list.filter(mine).length;
    if (o.keepRules) { for (const r of rules.list) if (mine(r)) delete r.set; }
    else rules.list = rules.list.filter(r => !mine(r));
    rules.ruleSets = rules.ruleSets.filter(x => x !== s);
    return {removed: s.name, rules: n, kept: !!o.keepRules};
  }
  function assign(rules, ids, name) {
    const s = need(rules, name), want = new Set(ids);
    let n = 0;
    for (const r of rules.list) if (want.has(r.id) || want.has(r.name)) { if (lower(s.name) === lower(DEFAULT)) delete r.set; else r.set = s.name; n++; }
    if (!n) fail("None of the given rules are on this board.");
    return n;
  }
  // Classes the incoming rules may scope that the board does not define yet.
  function mergeDesign(rules, src) {
    for (const key of ["netClasses", "diffPairClasses"]) for (const [k, v] of Object.entries(src?.[key] || {})) {
      rules[key] ||= {};
      if (!Object.prototype.hasOwnProperty.call(rules[key], k)) rules[key][k] = [...v];
    }
  }
  // A library set ({name, rules}) as a new board set.
  function addSet(rules, set, o = {}) {
    const name = freeName(rules, o.name || set.name);
    const s = create(rules, name, {enabled: o.enabled !== false, description: set.description});
    const src = R().migrate(clone(set.rules));
    mergeDesign(rules, src);
    const added = addRules(rules, src.list, s.name, s.name);
    return {set: s, rules: added.length};
  }
  function importText(rules, text, fileName = "", o = {}) {
    const RS = globalThis.AtriumRuleSets || fail("Rule set files need rule-sets.js.");
    return RS.importText(text, fileName).map(set => addSet(rules, set, o));
  }
  // One set (its rules, with the classes their scopes name) in the rule-set file format.
  function exportSet(rules, name) {
    const s = need(rules, name);
    const list = rules.list.filter(r => lower(setOf(r)) === lower(s.name)).map(({set, ...r}) => clone(r));
    const out = {format: "atrium-rules", version: 2, units: "mm", list};
    for (const key of ["netClasses", "diffPairClasses"]) if (rules[key] && Object.keys(rules[key]).length) out[key] = clone(rules[key]);
    return {name: s.name, ...(s.description ? {description: s.description} : {}), source: "board-rule-set", rules: R().normalize(out)};
  }
  function exportText(rules, names) {
    const RS = globalThis.AtriumRuleSets || fail("Rule set files need rule-sets.js.");
    return RS.exportText((Array.isArray(names) ? names : [names]).map(n => exportSet(rules, n)));
  }
  // Run fn on a working copy of the board rules; store the result normalised and checked.
  function edit(doc, project, fn) {
    if (doc?.kind !== "pcb") fail("Open a PCB layout to edit its rule sets.");
    const rules = clone(R().effective(doc, project)), out = fn(rules);
    R().store(doc, project, rules);
    return out;
  }

  // ---------------------------------------------------------------- MCP (board_rule_sets)
  function headless(project, doc, a = {}) {
    const op = a.op || "list", rules = () => R().effective(doc, project);
    const summary = () => ({document_id: doc.id, sets: list(rules()).map(s => ({name: s.name, enabled: s.enabled, rules: s.count, default: s.isDefault, ...(s.description ? {description: s.description} : {})}))});
    if (op === "list") {
      const r = rules(), out = summary();
      if (a.name) out.rules = r.list.filter(x => lower(setOf(x)) === lower(need(r, a.name).name)).map(x => ({id: x.id, name: x.name, type: x.type, priority: x.priority, enabled: x.enabled}));
      return out;
    }
    if (op === "export") return {document_id: doc.id, text: exportText(rules(), a.names || (a.name ? [a.name] : list(rules()).map(s => s.name)))};
    const res = edit(doc, project, r => {
      switch (op) {
        case "create": return {created: create(r, a.name, {enabled: a.enabled, description: a.description}).name};
        case "duplicate": return {created: duplicate(r, a.name, a.new_name, {enabled: a.enabled}).name};
        case "enable": return {enabled: setEnabled(r, a.name, true).name};
        case "disable": return {disabled: setEnabled(r, a.name, false).name};
        case "rename": return {renamed: rename(r, a.name, a.new_name).name};
        case "delete": return remove(r, a.name, {keepRules: !!a.keep_rules});
        case "assign": return {moved: assign(r, a.rules || [], a.name), to: a.name};
        case "import": return {imported: importText(r, a.text, a.file_name || "", {enabled: a.enabled}).map(x => ({name: x.set.name, rules: x.rules}))};
        case "add_library": {
          const RS = globalThis.AtriumRuleSets || fail("Library rule sets need rule-sets.js."), set = RS.get(project, a.name) || fail("No library rule set is named " + a.name + ".");
          const x = addSet(r, set, {name: a.new_name, enabled: a.enabled}); return {added: x.set.name, rules: x.rules};
        }
        default: fail("Unknown operation " + op + ".");
      }
      return null;
    });
    return {...summary(), op, ...res};
  }

  // ---------------------------------------------------------------- dialog section
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, cls, title) { const b = el("button", text, cls); b.type = "button"; b.onclick = act; if (title) b.title = title; return b; }
  // o: {ctx, project(), board(), say(text)}; o.ctx.edit wraps each change in one undo step.
  function section(o) {
    const root = el("section", null, "rgrp", {"aria-label": "Rule sets on this board"});
    const head = el("div", null, "rgrp-head");
    head.append(el("h3", "Sets on this board"), el("p", "Disabled sets are not checked and routing ignores them. Priorities stay as they are across the enabled sets.", "rgrp-help"));
    const items = el("div", null, "ui-list rgrp-items", {role: "listbox", "aria-label": "Board rule sets"});
    const detail = el("div", null, "rgrp-detail");
    const body = el("div", null, "rgrp-body"); body.append(items, detail);
    const nameIn = el("input", null, "rgrp-name", {type: "text", maxlength: "128", placeholder: "Set name", "aria-label": "Rule set name"});
    let selected = null;
    const rules = () => R().effective(o.board(), o.project());
    const run = (fn, done) => { try { let out; o.ctx.edit(() => { out = edit(o.board(), o.project(), fn); }); if (done) o.say(done(out)); paint(); o.onChange?.(); } catch (e) { o.say(e.message); } };
    const typed = () => nameIn.value.trim();
    const tools = el("div", null, "work-toolbar rgrp-tools");
    tools.append(nameIn,
      button("New", () => { const n = typed(); if (!n) { o.say("Type a name for the new set."); nameIn.focus(); return; } run(r => create(r, n).name, x => { selected = x; nameIn.value = ""; return "Created rule set " + x + "."; }); }, "", "Create an empty set with the typed name"),
      button("Duplicate", () => { if (!selected) return; run(r => duplicate(r, selected, typed() || undefined).name, x => { selected = x; nameIn.value = ""; return "Duplicated as " + x + " (disabled; enable it to use it)."; }); }, "", "Copy the selected set and its rules"),
      button("Rename", () => { const n = typed(); if (!selected || !n) { o.say("Select a set and type its new name."); return; } run(r => rename(r, selected, n).name, x => { selected = x; nameIn.value = ""; return "Renamed to " + x + "."; }); }, "", "Rename the selected set to the typed name"),
      button("Import…", async () => {
        try {
          const f = o.ctx.pickFile ? await o.ctx.pickFile([".json", ".waffle-rules"]) : null;
          if (!f) return;
          const text = f.text ? await f.text() : new TextDecoder().decode(await f.arrayBuffer());
          run(r => importText(r, text, f.name || ""), got => { selected = got[0]?.set.name || selected; return got.map(g => g.set.name + " (" + g.rules + " rules)").join(", ") + " added to the board."; });
        } catch (e) { o.say(e.message); }
      }, "", "Add sets from a rule set file to this board"),
      button("Export…", async () => {
        if (!selected) return;
        try { await o.ctx.exportFile?.(selected.replace(/[\\/:*?"<>|]/g, "-") + ".waffle-rules.json", exportText(rules(), [selected])); } catch (e) { o.say(e.message); }
      }, "", "Export the selected set as a rule set file"),
      button("Delete", () => {
        if (!selected) return;
        const s = list(rules()).find(x => lower(x.name) === lower(selected));
        if (!s || s.isDefault) { o.say("The Default set cannot be deleted. Disable it instead."); return; }
        run(r => remove(r, s.name, {keepRules: true}), x => { selected = DEFAULT; return "Deleted " + x.removed + "; its " + x.rules + " rule" + (x.rules === 1 ? "" : "s") + " moved to Default."; });
      }, "vs-danger", "Delete the selected set; its rules move to Default"));
    function paint() {
      const r = rules(), sets = list(r);
      if (!sets.some(s => lower(s.name) === lower(selected))) selected = sets[0]?.name || null;
      const refocus = items.contains(document.activeElement);
      items.replaceChildren();
      for (const s of sets) {
        const row = el("div", null, "ui-row rgrp-row", {role: "option", tabindex: s.name === selected ? "0" : "-1", "aria-selected": String(s.name === selected)});
        const on = el("input", null, null, {type: "checkbox", "aria-label": (s.enabled ? "Disable " : "Enable ") + s.name});
        on.checked = s.enabled;
        on.onclick = e => e.stopPropagation();
        on.onchange = () => run(x => setEnabled(x, s.name, on.checked).name, n => n + (on.checked ? " enabled." : " disabled: its rules are not checked or used for routing."));
        row.dataset.enabled = String(s.enabled);
        // A library list row: the enable checkbox, the set's name and its rule count as the meta.
        const text = el("span", null, "ui-row-text"); text.append(el("span", s.name, "ui-row-title rgrp-label"));
        row.append(on, text, el("span", String(s.count), "ui-row-meta", {title: s.count + " rule" + (s.count === 1 ? "" : "s")}));
        row.onclick = () => { selected = s.name; paint(); };
        row.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selected = s.name; paint(); } };
        items.append(row);
      }
      const cur = items.querySelector('[aria-selected="true"]');
      if (refocus) cur?.focus();
      detail.replaceChildren();
      const s = sets.find(x => x.name === selected);
      if (!s) return;
      const mine = r.list.filter(x => lower(setOf(x)) === lower(s.name));
      detail.append(el("p", s.name + " · " + mine.length + " rule" + (mine.length === 1 ? "" : "s") + (s.enabled ? "" : " · disabled"), "rgrp-sub"));
      if (!mine.length) { detail.append(el("p", "No rules yet. Move rules here from another set, or import a file.", "ui-empty rgrp-empty")); return; }
      const table = el("table", null, "rules-table"), thead = el("thead"), hr = el("tr"), tbody = el("tbody");
      for (const h of ["", "Rule", "Type", "Priority", "Constraint"]) hr.append(el("th", h, null, {scope: "col"}));
      thead.append(hr); table.append(thead, tbody);
      const picks = [];
      for (const x of mine) {
        const tr = el("tr", null, x.enabled ? "" : "is-muted"), c = el("input", null, null, {type: "checkbox", "aria-label": "Select " + x.name});
        picks.push([c, x.id]);
        const td = el("td"); td.append(c);
        tr.append(td, el("td", x.name), el("td", R().types[x.type]?.title || x.type), el("td", String(x.priority)), el("td", R().constraintText(x, "mm")));
        tbody.append(tr);
      }
      const move = el("select", null, null, {"aria-label": "Move selected rules to"});
      move.add(new Option("Move selected to…", ""));
      for (const t of sets) if (t.name !== s.name) move.add(new Option(t.name, t.name));
      move.onchange = () => {
        const ids = picks.filter(([c]) => c.checked).map(([, id]) => id), to = move.value;
        move.value = "";
        if (!to) return;
        if (!ids.length) { o.say("Tick the rules to move first."); return; }
        run(x => assign(x, ids, to), n => n + " rule" + (n === 1 ? "" : "s") + " moved to " + to + ".");
      };
      const wrap = el("div", null, "rules-table-wrap"); wrap.append(table);
      detail.append(wrap, move);
    }
    root.append(head, tools, body);
    paint();
    root.refresh = paint;
    return root;
  }

  return Object.freeze({DEFAULT, list, create, duplicate, setEnabled, rename, remove, assign, addSet, importText, exportText, exportSet, edit, headless, section, setOf});
})();
