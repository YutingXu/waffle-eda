"use strict";
// HDI Via Setup (Design › HDI Via Setup…): the board's sequential build-up and the
// drill pairs, microvia and rules that follow from it. The model, the checks and the
// router's via choice live in viastack.js (AtriumViaStack.hdi); this file is the dialog.
//
// The dialog edits doc.hdi ({top, bottom, anyLayer?, skip?, stacking?, microvia?}),
// optionally writes the build-up's drill pairs into the layer stack and adds the
// Layer Pairs and HDI Vias rules, all in one undo step.
globalThis.AtriumHDI = (() => {
  const VS = () => globalThis.AtriumViaStack, H = () => globalThis.AtriumViaStack.hdi;
  const PRESETS = [["none", "None (through, blind and buried only)"], ["1", "1+N+1"], ["2", "2+N+2"], ["3", "3+N+3"], ["any", "Any-layer (ELIC)"], ["custom", "Custom"]];
  const IPC_CHOICES = [["VII", "VII · Filled and capped"], ["VI", "VI · Filled and covered"], ["V", "V · Filled"], ["none", "None"]];
  const round = v => Math.round(v * 1e4) / 1e4;
  // i18n (docs/translating.md): static text is extracted from this file ("hdi"); built text goes through t().
  // The stub keeps English where i18n.js is absent (node tests).
  // "\u0029" is ")" after a placeholder: scripts/i18n-extract.py ends a define() table at the first "})".
  const AtriumI18n = globalThis.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s), scope() {}};
  AtriumI18n.scope(".hdi-dialog", ["hdi"]);
  const t = AtriumI18n.define({
    "hdi.diagram_label": "{buildup}, {layers} copper layers, {pairs} drill pairs",
    "hdi.buildup_named": "{name} build-up",
    "hdi.no_buildup": "No build-up", // i18n-ignore
    "hdi.stage_core": "core", "hdi.stage": "build-up {n}",
    "hdi.laser_lower": "laser microvia",
    "hdi.bar_title": "{from} – {to} · {kind}",
    "hdi.sub": "{board} · {layers} copper layers",
    "hdi.board": "Board", // i18n-ignore
    "hdi.summary_one": "{name}: core L{from}–L{to}, {count} lamination ({stages}\u0029.",
    "hdi.summary_other": "{name}: core L{from}–L{to}, {count} laminations ({stages}\u0029.",
    "hdi.after_stage": "After build-up {n}",
    "hdi.span_through": "Through", // i18n-ignore
    "hdi.vias_one": "{count} via {span}", "hdi.vias_other": "{count} vias {span}",
    "hdi.needs_depth": " · needs a controlled-depth drill", "hdi.not_buildable_why": " · not buildable: {reason}",
    "hdi.vip_one": "{count} via in SMD pads", "hdi.vip_other": "{count} vias in SMD pads",
    "hdi.vip_open": ", {count} not filled (IPC-4761 V–VII)", "hdi.vip_filled": ", all filled",
    "hdi.stacks_one": "{count} stacked via site", "hdi.stacks_other": "{count} stacked via sites",
    "hdi.stacks_tall": ", up to {count} microvias high",
    "hdi.set": "{name} build-up set",
    "hdi.removed": "HDI build-up removed", // i18n-ignore
    "hdi.pairs_one": "{count} drill pair in the layer stack", "hdi.pairs_other": "{count} drill pairs in the layer stack",
    "hdi.rules_added": "rules {rules} added"
  });
  // Drill-pair kinds as the table shows them (viastack.js spanStatus kinds).
  const KINDS = {through: "Through", blind: "Blind", buried: "Buried", microvia: "Microvia"};

  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, cls, title) {const b = el("button", text, cls); b.classList.add("ui-button"); b.type = "button"; b.onclick = act; if (title) b.title = title; return b;}
  function select(options, value, label) {
    const s = el("select", null, "hdi-select ui-field", {"aria-label":label});
    for (const [k, t] of options) s.add(new Option(t, k));
    s.value = value;
    return s;
  }
  function number(value, label, step = .005, unit = "mm") {
    const n = el("input", null, "hdi-num ui-field", {type:"number", min:"0", step:String(step), "aria-label":label});
    n.dataset.numericUnit = unit; n.value = String(value);
    return n;
  }
  const presetOf = c => !c ? "none" : c.anyLayer ? "any" : c.top === c.bottom && c.top >= 1 && c.top <= 3 ? String(c.top) : "custom";

  // Rule objects as rules.js makes them: field defaults, scope All.
  function newRule(R, type, name) {
    const t = R.types[type], r = {id:globalThis.Atrium.id(), type, name, comment:"Added by HDI Via Setup.", enabled:true, priority:1, scope:globalThis.AtriumDesignQueryRecord.selector("all")}; // i18n-ignore: stored in the rule
    for (const f of t.fields) r[f.key] = Array.isArray(f.def) ? [...f.def] : f.def && typeof f.def === "object" ? {...f.def} : f.def;
    return r;
  }
  // Adds the Layer Pairs and HDI Vias rules the board lacks and, with a build-up, Routing Via
  // Style and Minimum Annular Ring rules scoped to the microvia drill (Altium practice: a
  // higher-priority rule for microvias), so the board-wide via rules do not flag them.
  // Returns the names added.
  function addRules(doc, project, defs) {
    const R = globalThis.AtriumRules;
    if (!R) throw Error("The rules module is not loaded.");
    const set = R.effective(doc, project), added = [];
    for (const [type, name] of [["layerPairs", "LayerPairs"], ["hdiVias", "HDIVias"]]) {
      if (set.list.some(r => r.type === type)) continue;
      set.list.push(newRule(R, type, name)); added.push(name);
    }
    const c = H().config(doc, defs), mv = c?.microvia;
    if (mv) {
      const scope = globalThis.AtriumDesignQueryRecord.create("via where holeDiameter <= " + round(mv.drill) + " mm");
      const ring = round(Math.max(.01, (mv.diameter - mv.drill) / 2));
      for (const [type, name, props] of [["viaStyle", "RoutingVias_Microvia", {diameterMin:mv.diameter, diameterPreferred:mv.diameter, holeMin:mv.drill, holePreferred:mv.drill}],
        ["annularRing", "MinimumAnnularRing_Microvia", {min:ring}]]) {
        if (set.list.some(r => r.type === type && r.name === name)) continue;
        set.list.push({...newRule(R, type, name), scope, priority:0, ...props}); added.push(name);
      }
    }
    if (added.length) R.store(doc, project, set);
    return added;
  }
  // Headless apply: {top, bottom, anyLayer, skip, stacking, microvia, pairs:true, rules:true}.
  function apply(doc, defs, o = {}, project) {
    const cfg = H().set(doc, o.config === undefined ? o : o.config);
    const out = {config:cfg, pairs:null, rules:[]};
    if (cfg && o.pairs !== false) out.pairs = H().applyPairs(doc, defs);
    if (cfg && o.rules !== false && globalThis.AtriumRules) out.rules = addRules(doc, project, defs);
    return out;
  }

  // Layer diagram: copper rows top to bottom, the core shaded, and a bar per drill pair.
  function diagram(doc, defs, c, pairs) {
    const keys = c?.keys || VS().keysOf(doc, null, defs), n = keys.length, box = el("div", null, "hdi-diagram", {role:"img"});
    const st = H().stages(doc, defs, c), core = st[0];
    box.setAttribute("aria-label", t("hdi.diagram_label", {buildup: c ? t("hdi.buildup_named", {name: H().name(c)}) : t("hdi.no_buildup"), layers: n, pairs: pairs.length}));
    box.style.setProperty("--hdi-rows", String(n));
    box.style.setProperty("--hdi-cols", String(Math.max(1, pairs.length)));
    keys.forEach((k, i) => {
      const inCore = i >= core.lo && i <= core.hi, stage = st.find(s => s.added.includes(k));
      const row = el("div", null, "hdi-layer" + (inCore && c ? " is-core" : ""), {style:"grid-row:" + (i + 1)});
      row.append(el("span", "L" + (i + 1), "hdi-lnum"), el("span", k, "hdi-lname"), el("span", !c ? "" : inCore ? t("hdi.stage_core") : t("hdi.stage", {n: stage?.index ?? ""}), "hdi-lstage"));
      box.append(row);
    });
    pairs.forEach((p, j) => {
      const a = keys.indexOf(p.from), b = keys.indexOf(p.to);
      if (a < 0 || b < 0) return;
      const bar = el("div", null, "hdi-bar is-" + (p.method === "laser" ? "laser" : "mech") + (p.ok === false ? " is-bad" : ""), {style:"grid-row:" + (a + 1) + " / " + (b + 2) + ";grid-column:" + (j + 2), title:t("hdi.bar_title", {from: p.from, to: p.to, kind: p.method === "laser" ? t("hdi.laser_lower") : p.kind})});
      box.append(bar);
    });
    return box;
  }

  // Board summary: vias per span with their build-up status, via-in-pad and stacks.
  function survey(doc, defs, c) {
    const keys = c?.keys || VS().keysOf(doc, null, defs), spans = new Map();
    for (const v of doc.items || []) {
      if (v.kind !== "via") continue;
      const [a, b] = VS().spanOf(v), k = a + "|" + b;
      if (!spans.has(k)) spans.set(k, {a, b, count:0, st:H().spanStatus(doc, a, b, defs, c)});
      spans.get(k).count++;
    }
    const vip = H().viasInPads(doc, defs, keys), stacks = H().stacks(doc, defs, keys, c);
    return {spans:[...spans.values()].sort((p, q) => keys.indexOf(p.a) - keys.indexOf(q.a) || keys.indexOf(p.b) - keys.indexOf(q.b)), vip, stacks, keys};
  }

  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") {ctx.info?.("Open a board layout to set up HDI vias."); return null;}
    if (!VS()?.hdi) {ctx.info?.("The via stack module is not loaded."); return null;}
    const defs = ctx.defs, keys = VS().keysOf(doc, null, defs), n = keys.length;
    let state = {...(H().cleanConfig(doc.hdi) || {version:1, top:0, bottom:0})};
    let writePairs = true, writeRules = true;
    document.querySelectorAll("dialog.hdi-dialog").forEach(x => x.close());
    const d = el("dialog", null, "ui-dialog work-dialog hdi-dialog", {"aria-label":"HDI Via Setup"});
    const head = el("div", null, "vs-head");
    head.append(el("h2", "HDI Via Setup", "ui-dialog-title"), el("span", t("hdi.sub", {board: doc.name || t("hdi.board"), layers: n}), "vs-sub"));
    const body = el("div", null, "hdi-body ui-dialog-body"), left = el("div", null, "hdi-form"), right = el("div", null, "hdi-side");
    body.append(left, right);
    const status = el("p", null, "hdi-status", {role:"status"});
    // A draft board for previews: the stored doc with the edited build-up.
    const draft = () => ({...doc, hdi:H().cleanConfig(state) || undefined});
    const config = () => H().config(draft(), defs, keys);

    const preset = select(PRESETS, presetOf(H().config(doc, defs, keys)), "Build-up");
    const top = number(state.top || 0, "Build-up layers on top", 1, "ea"), bottom = number(state.bottom || 0, "Build-up layers on bottom", 1, "ea");
    for (const x of [top, bottom]) {x.min = "0"; x.max = String(Math.max(0, n - 2));}
    const skip = el("input", null, null, {type:"checkbox", class:"ui-checkbox", "aria-label":"Allow skip vias"}); skip.checked = state.skip !== false;
    const stacking = select([["stacked", "Stacked (copper filled)"], ["staggered", "Staggered"]], state.stacking || "stacked", "Microvia stacking");
    const mv = state.microvia || {};
    const mvDia = number(mv.diameter ?? .25, "Microvia land diameter (mm)"), mvDrill = number(mv.drill ?? .1, "Microvia drill (mm)");
    const mvIpc = select(IPC_CHOICES, mv.ipc4761 || "VII", "Microvia IPC-4761 type");
    const pairsBox = el("input", null, null, {type:"checkbox", class:"ui-checkbox", "aria-label":"Define the drill pairs in the layer stack"}); pairsBox.checked = writePairs;
    const rulesBox = el("input", null, null, {type:"checkbox", class:"ui-checkbox", "aria-label":"Add the Layer Pairs and HDI Vias rules"}); rulesBox.checked = writeRules;
    const field = (label, control, hint) => {const l = el("label", null, "hdi-field"); l.append(el("span", label, "hdi-k"), control); if (hint) l.append(el("small", hint, "hdi-hint")); return l;};
    const group = (title, ...rows) => {const f = el("fieldset", null, "hdi-group"); f.append(el("legend", title), ...rows); return f;};
    left.append(
      group("Build-up", field("Construction", preset), field("Top build-up layers", top), field("Bottom build-up layers", bottom),
        el("p", null, "hdi-hint hdi-summary")),
      group("Microvias", field("Land / drill (mm)", (() => {const w = el("span", null, "hdi-pair"); w.append(mvDia, el("span", "/", "hdi-hint"), mvDrill); return w;})()),
        field("Fill (IPC-4761)", mvIpc), field("Stacking", stacking), field("Skip vias", skip, "Laser vias over two dielectrics")),
      group("Apply", field("Drill pairs", pairsBox, "Write the build-up's drill pairs into the layer stack"), field("Rules", rulesBox, "Add Layer Pairs and HDI Vias rules if missing")));
    const summary = left.querySelector(".hdi-summary");

    function read() {
      const p = preset.value, room = Math.max(0, n - 2);
      if (p === "none") state = {version:1, top:0, bottom:0};
      else if (p === "any") state = {...state, anyLayer:true};
      else {
        delete state.anyLayer;
        if (p !== "custom") {top.value = bottom.value = p;}
        state.top = Math.max(0, Math.min(room, Math.round(Number(top.value) || 0)));
        state.bottom = Math.max(0, Math.min(room - state.top, Math.round(Number(bottom.value) || 0)));
      }
      if (skip.checked) delete state.skip; else state.skip = false;
      if (stacking.value === "staggered") state.stacking = "staggered"; else delete state.stacking;
      const dia = Number(mvDia.value), drill = Number(mvDrill.value);
      state.microvia = {...(dia > 0 ? {diameter:round(dia)} : {}), ...(drill > 0 ? {drill:round(drill)} : {}), ipc4761:mvIpc.value};
      writePairs = pairsBox.checked; writeRules = rulesBox.checked;
    }
    function paint() {
      read();
      const c = config(), b = draft(), on = !!c;
      for (const x of [top, bottom]) x.disabled = preset.value !== "custom";
      for (const x of [skip, stacking, mvDia, mvDrill, mvIpc, pairsBox]) x.disabled = !on;
      if (on && preset.value !== "custom") {top.value = String(c.top); bottom.value = String(c.bottom);}
      if (!on && preset.value !== "none" && preset.value !== "custom") status.textContent = "This stack has too few copper layers for that build-up.";
      const st = H().stages(b, defs, c);
      summary.textContent = on ? t(H().laminations(c, st) === 1 ? "hdi.summary_one" : "hdi.summary_other", {name: H().name(c), from: c.core[0] + 1, to: c.core[1] + 1, count: H().laminations(c, st), stages: st.map(s => "L" + (s.lo + 1) + "–L" + (s.hi + 1)).join(" → ")})
        : "Without a build-up the router uses the layer stack's drill pairs, and lamination is not checked.";
      const pairs = H().recommendedPairs(b, defs, c).map(p => ({...p, ok:true}));
      const stored = (() => {try {return globalThis.AtriumStackup?.stored?.(doc)?.drillPairs || [];} catch {return [];}})();
      for (const p of stored) if (!pairs.some(q => q.from === p.from && q.to === p.to)) {const s = H().spanStatus(b, p.from, p.to, defs, c); pairs.push({...p, kind:s.kind, method:s.method, ok:s.ok, extra:true});}
      right.replaceChildren(el("h3", "Layers and drill pairs", "hdi-h3"), diagram(b, defs, c, pairs),
        (() => {const l = el("p", null, "hdi-hint hdi-legend"); l.append(el("span", null, "hdi-swatch is-mech"), "Mechanical drill ", el("span", null, "hdi-swatch is-laser"), "Laser microvia"); return l;})());
      const table = el("table", null, "vs-table hdi-table"), thead = el("thead"), hr = el("tr"), tbody = el("tbody");
      for (const h of ["Drill pair", "Type", "Drilled", "Layer stack"]) hr.append(el("th", h, null, {scope:"col"}));
      thead.append(hr); table.append(thead, tbody);
      for (const p of pairs) {
        const tr = el("tr"), defined = p.kind === "through" || stored.some(q => q.from === p.from && q.to === p.to);
        tr.append(el("td", "L" + (keys.indexOf(p.from) + 1) + "–L" + (keys.indexOf(p.to) + 1) + " " + p.from + " – " + p.to), el("td", p.method === "laser" ? "Laser microvia" : KINDS[p.kind] || p.kind[0].toUpperCase() + p.kind.slice(1)),
          el("td", p.ok === false ? "Not buildable" : p.stage == null ? "" : p.stage ? t("hdi.after_stage", {n: p.stage}) : "Core", p.ok === false ? "hdi-bad" : ""),
          el("td", defined ? "Defined" : on && writePairs ? "Will be defined" : "Not defined", defined ? "" : "hdi-hint"));
        tbody.append(tr);
      }
      const wrap = el("div", null, "vs-table-wrap"); wrap.append(table); right.append(wrap);
      // What the board already has.
      const s = survey(b, defs, c), list = el("ul", null, "hdi-findings");
      for (const e of s.spans) {
        const name = e.a === keys[0] && e.b === keys.at(-1) ? t("hdi.span_through") : "L" + (keys.indexOf(e.a) + 1) + "–L" + (keys.indexOf(e.b) + 1);
        const li = el("li", t(e.count === 1 ? "hdi.vias_one" : "hdi.vias_other", {count: e.count, span: name}) + (e.st.ok ? e.st.method === "controlled-depth" ? t("hdi.needs_depth") : "" : t("hdi.not_buildable_why", {reason: e.st.reason})));
        if (!e.st.ok || e.st.method === "controlled-depth") li.className = "hdi-bad";
        list.append(li);
      }
      const open = s.vip.filter(e => !e.filled).length;
      if (s.vip.length) list.append(el("li", t(s.vip.length === 1 ? "hdi.vip_one" : "hdi.vip_other", {count: s.vip.length}) + (open ? t("hdi.vip_open", {count: open}) : t("hdi.vip_filled")), open ? "hdi-bad" : ""));
      const tall = s.stacks.reduce((m, x) => Math.max(m, x.microvias), 0);
      if (s.stacks.length) list.append(el("li", t(s.stacks.length === 1 ? "hdi.stacks_one" : "hdi.stacks_other", {count: s.stacks.length}) + (tall ? t("hdi.stacks_tall", {count: tall}) : "")));
      if (!list.childElementCount) list.append(el("li", "No vias on this board yet."));
      right.append(el("h3", "On this board", "hdi-h3"), list);
    }
    for (const x of [preset, top, bottom, skip, stacking, mvDia, mvDrill, mvIpc, pairsBox, rulesBox]) x.addEventListener("change", () => {status.textContent = ""; paint();});

    const actions = el("div", null, "work-actions ui-dialog-actions");
    const save = button("Apply", () => { // i18n-ignore: common buttons
      try {
        read();
        let out;
        ctx.edit(() => {out = apply(doc, defs, {config:H().cleanConfig(state), pairs:writePairs, rules:writeRules}, ctx.project);});
        const bits = [out.config ? t("hdi.set", {name: H().name(H().config(doc, defs))}) : t("hdi.removed")];
        if (out.pairs) bits.push(t(out.pairs.length === 1 ? "hdi.pairs_one" : "hdi.pairs_other", {count: out.pairs.length}));
        if (out.rules.length) bits.push(t("hdi.rules_added", {rules: out.rules.join(", ")}));
        ctx.info?.(bits.join("; "));
        ctx.refresh?.();
        d.close();
      } catch (e) {status.textContent = e.message;}
    });
    save.dataset.variant = "primary";
    actions.append(button("Cancel", () => d.close()), save);
    d.append(head, body, status, actions);
    d.addEventListener("keydown", e => {if (e.key === "Escape") {e.preventDefault(); d.close();}});
    d.addEventListener("close", () => d.remove(), {once:true});
    document.body.append(d);
    paint(); globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: preset, defaultAction: false}); d.showModal(); preset.focus();
    return d;
  }

  // Design › HDI Via Setup… (registered with the editor host; lazy.js loads this file).
  function attach(host) {
    host.registerAction("hdi-setup", () => open({project:host.project(), doc:host.doc(), defs:host.defs(), edit:host.edit, info:host.info, refresh:() => host.invalidate?.()}));
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({open, apply, addRules, attach, PRESETS});
})();
