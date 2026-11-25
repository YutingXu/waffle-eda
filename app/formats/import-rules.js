"use strict";
// Imported board rules. The import report keeps the original records, or a 1.x
// board carries them inline. Until they are converted, DRC checks the board against
// Waffle's defaults (the PiDP-11 fixture has 54 markers under the defaults and 2 under its own rules).
// After an import
// this asks once, in the docked Messages panel (not a modal dialog):
//
//   This board has 41 design rules from Altium. Use them?
//   [Use the board's rules] [Keep Waffle defaults] [Review…]
//
// Use runs Rules › Altium Source Rules › Replace with supported rules (AtriumRules.replaceWithSource)
// as one undoable edit; Review… opens the rules editor on Altium Source Rules. The preference
// pcb.importRules (Preferences › PCB › Imported boards) answers for the user: "use" (default: the
// board is checked and poured under its own rules, as in its source tool), "ask" or "keep". KiCad, Eagle and EasyEDA boards are never asked: their importers convert the
// rules directly (into the project rule book), so there are no source records left to decide on.
// Rules converted from a board's source records carry origin {kind: "import", tool, board}: a board with
// source records and no such rule is pending.
//
//   AtriumImportRules.pending(project)        -> [{doc, count, tool}] boards with unconverted source rules
//   AtriumImportRules.apply(doc, project, defs?) -> {converted, total, types, repoured, kept}; the board's rules in the
//                                                project rule book (headless).
//                                                With defs, Altium's stored pour fill is kept (it was poured under
//                                                these rules; `kept` pours); pours edited since import are repoured.
//   AtriumImportRules.offer(host)             -> "ask" | "use" | "keep" | null, after an import (editor.js)
globalThis.AtriumImportRules = (() => {
  const R = () => globalThis.AtriumRules;
  const source = d => globalThis.AtriumProjectRules?.sourceDocument?.(d) || d;
  const MODES = ["ask", "use", "keep"];
  const plural = (n, one, many = one + "s") => globalThis.AtriumI18n?.plural?.(n, one, many) ?? n + " " + (n === 1 ? one : many);

  const converted = (project, d) => !!d.ruleCheckSelection || !!d.appliedSourceRuleRecords?.length || !!globalThis.AtriumProjectRules?.book(project).list.some(r => r.origin?.kind === "import" && r.origin.board === d.id);
  function pending(project, documentIds) {
    const selected = documentIds && new Set(documentIds), list = [];
    for (const doc of project?.documents || []) {
      if (doc.kind!=="pcb" || selected&&!selected.has(doc.id) || converted(project,doc)) continue;
      const rows=source(doc).sourceRules;
      if (rows?.length) list.push({doc,count:rows.length,tool:"Altium"});
    }
    return list;
  }
  // The rules editor's Replace with supported rules, applied to the board's stored rules.
  function apply(doc, project, defs = null, original = source(doc)) {
    const RR = R();
    globalThis.AtriumSignals?.attach?.(project); // pour signatures read the board's project (pcb-pours.js)
    if (!RR?.replaceWithSource) throw Error("The design rule engine is not loaded.");
    const before = RR.migrate(RR.stored(doc, project)), r = RR.replaceWithSource(before, original.sourceRules || [], original);
    const selection=RR.sourceCheckSelection(original);
    if (!r.converted) {
      if(selection)doc.ruleCheckSelection=selection;
      return {converted:0, total:r.total, types:0, report:r.report, repoured:0, kept:0};
    }
    // Rules converted from the source records are marked, so the board is no longer pending.
    const origin = new Map();
    for (const [id, record] of r.origins) origin.set(id, {boards:[doc.id], origin:{kind:"import", tool:"Altium", board:doc.id, record}});
    const {kept,repoured}=RR.adoptSourcePours(doc,project,defs,()=>{
      RR.store(doc,project,r.set,origin);
      if(selection)doc.ruleCheckSelection=selection;
    });
    return {converted:r.converted, total:r.total, types:r.types, report:r.report, repoured, kept};
  }

  async function mode() {
    try {
      const P = globalThis.AtriumPrefs || (globalThis.AtriumLazy?.modules?.().includes("AtriumPrefs") ? await AtriumLazy.need("AtriumPrefs") : null);
      const m = P?.get?.("pcb.importRules");
      return MODES.includes(m) ? m : "use";
    } catch {return "ask";}
  }
  async function messages() {
    if (globalThis.AtriumMessages) return AtriumMessages;
    return globalThis.AtriumLazy?.modules?.().includes("AtriumMessages") ? AtriumLazy.need("AtriumMessages") : null;
  }
  const GROUP = "Imported rules";
  const row = (list, cls, text) => list.map(x => ({class:cls, source:"Import", text:typeof text === "function" ? text(x) : text, document:x.doc.name, documentId:x.doc.id}));

  // The rule compiler must be ready before converted scopes can sign stored copper.
  async function prepareUse() {
    if (!globalThis.AtriumDesignQuery && globalThis.AtriumLazy?.need) {
      await AtriumLazy.need("AtriumDesignQuery");
      if (!globalThis.AtriumDesignQuery) throw Error("The scoped-rule compiler is not loaded.");
    }
  }

  // Converts every pending board in one undo step. Returns the rows to show.
  function use(host, list) {
    const project = host.project(), done = [];
    host.edit(() => {for (const x of list) done.push({...x, ...apply(x.doc, project, host.defs())});});
    const skipped = done.reduce((n, x) => n + x.total - x.converted, 0);
    host.info("Using the board's design rules: " + done.map(x => x.converted + " of " + x.total + " converted").join(", ") +
      (skipped ? " · " + plural(skipped, "record") + " without a Waffle equivalent (Design › Rules › Altium Source Rules)" : ""));
    return row(done, "Info", x => "Using " + plural(x.converted, "design rule") + " from " + x.tool + " (" + x.types + " rule types replaced)" +
      (x.total > x.converted ? "; " + (x.total - x.converted) + " " + (x.total - x.converted === 1 ? "record has" : "records have") + " no Waffle equivalent and stay as source rules." : "."));
  }
  function review(host, x) {
    if (host.currentId?.() !== x.doc.id) host.selectDocument?.(x.doc.id);
    const ctx = {project:host.project(), doc:host.doc(), defs:host.defs(), edit:host.edit, info:host.info, units:host.units?.(),
      exportFile:host.exportFile, pickFile:globalThis.AtriumIO?.pickFile, connections:() => host.connections?.(), section:"sources"};
    R().open(ctx);
  }

  const offered=new WeakMap();
  async function offer(host, documentIds) {
    const project=host?.project?.();
    if(!project)return null;
    let seen=offered.get(project);if(!seen)offered.set(project,seen=new Map());
    const originals=new Map();
    let list=pending(project,documentIds).filter(({doc})=>{
      const rows=source(doc).sourceRules;
      let versions=seen.get(doc.id);if(!versions)seen.set(doc.id,versions=new WeakSet());
      if(versions.has(rows))return false;
      versions.add(rows);originals.set(doc.id,rows);return true;
    });
    if (!list.length) return null;
    const current=()=>host.project()===project?pending(project,originals.keys()).filter(x=>source(x.doc).sourceRules===originals.get(x.doc.id)):[];
    const m = await mode();
    if (m === "keep") return m;
    const M = await messages().catch(() => null), ctx = host.messageContext?.() || {info:host.info};
    list=current();if(!list.length)return null;
    if (m === "use") {
      // The default: an imported board is checked and poured under its own rules, as in its source tool.
      try {await prepareUse();}
      catch (error) {
        for (const [id, rows] of originals) seen.get(id)?.delete(rows);
        throw error;
      }
      list=current();if(!list.length)return null;
      const rows = use(host, list);
      M?.show(ctx, {title:"Imported board rules", group:GROUP, messages:rows, focus:false,
        actions:[{label:"Review…", title:"Open Design › Rules on the board's converted and source-only rules", run:() => review(host, list[0])}]});
      host.info("Using the board's own design rules. Preferences › PCB › Imported boards changes this.");
      return m;
    }
    if (!M) {host.info("This board has design rules from Altium: Design › Rules › Altium Source Rules converts them."); return m;}
    const n = list.reduce((s, x) => s + x.count, 0), tools = [...new Set(list.map(x => x.tool))].join(" and ");
    let open = true;
    const finish = rows => {open = false; M.show(ctx, {title:"Imported board rules", group:GROUP, messages:rows, actions:[], focus:false});};
    const still = () => {
      if (!open) return null;
      const now = current();
      if (!now.length) {open=false;return null;}
      return now;
    };
    M.show(ctx, {title:"Imported board rules", group:GROUP, focus:false,
      messages:row(list, "Warning", x => (list.length > 1 ? x.doc.name + " has " : "This board has ") + plural(x.count, "design rule") + " from " + x.tool +
        ". Use them? Until then the board is checked against Waffle's default rules."),
      actions:[
        {label:"Use the board's rules", title:"Convert the supported " + tools + " rules and check the board against them (one undo step)",
          run:async () => {
            if (!still()) return;
            try {
              await prepareUse();
              const now = still();
              if (now) finish(use(host, now));
            } catch (error) {host.info(error.message);}
          }},
        {label:"Keep Waffle defaults", title:"Check the board against Waffle's default rules; Design › Rules › Altium Source Rules converts them later",
          run:() => {const now = still(); if (now) {finish(row(now, "Info", "Keeping Waffle's default rules. Design › Rules › Altium Source Rules converts the board's rules later.")); host.info("Keeping Waffle's default design rules");}}},
        {label:"Review…", title:"Open Design › Rules on the board's " + plural(n, "source rule"),
          run:() => {const now = still(); if (now) review(host, now[0]);}}]});
    host.info("This board has " + plural(n, "design rule") + " from " + tools + ": choose in Messages whether to use them.");
    return m;
  }

  return Object.freeze({MODES, pending, apply, offer});
})();
