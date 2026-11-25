"use strict";

// AtriumRelease: pre-flight gates, versioned release packages and the release history behind
// File › Release… (release-ui.js). DOM-free: the MCP tools `release` and `list_releases` and the
// tests run it headless. It drives AtriumOutputJobs (output-jobs.js) and adds:
//
//   packageName(project, set, {revision, variant, date})  -> "<project>-<revision>-<variant>-<date>"
//       (the variant segment is left out when the project has no assembly variants)
//   targets(project, set, choice?)   -> the variants to release: [{ref, key, name}] (ref: undefined active,
//       null base, else a variant id). choice: "active" | "base" | "all" | [names] (default set.variants)
//   preflight(project, set, opts)    -> {checks: [{id, label, status: pass|warn|fail|skip, summary, items, fix}], ok}
//       DRC (with waivers), ERC, BOM completeness (missing MPNs warn), the variant check, unsaved and
//       uncommitted changes (opts.git: {available, commit, branch, dirty}; opts.unsaved: true).
//   blocking(checks, overrides)     -> the failed checks no override covers
//   release(project, set, opts)     -> Promise<{name, ok, packages, files, record}>: one package per variant,
//       each with release.json (files, SHA-256, tool version, git commit, rules hash, waivers, gates,
//       overrides) and RELEASE.md. opts: date, revision, variants, overrides [{check, reason}], notes,
//       git, unsaved, cache (createCache()), worker (true: DOM-free outputs in release-worker.js),
//       signal (AbortSignal), progress(e), files (false: names only).
//   list(project) / add(project, record)   project.releases (newest last, at most 200)
//   compare(a, b, {before, after})   -> {files: {added, removed, changed, same}, bom: {added, removed, changed},
//       design: AtriumDiff summary when both designs are given (else null), notes}
//   createCache()                   -> per-output results keyed by an input hash (see inputHash)
//   inputHash(slices, kind, options, vars, variantKey) -> the cache key of one output
//   designHash(project) / rulesHash(project, board)
//
// Records (project.releases) are small: names, hashes, gates, overrides and a BOM snapshot per
// variant, never the files. The files and the full design live in the package and in Git.
globalThis.AtriumRelease = (() => {
  const VERSION = 1, MAX_RECORDS = 200, MAX_FILES = 2000;
  const J = () => globalThis.AtriumOutputJobs || fail("Release needs output-jobs.js.");
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = v => typeof v === "string";
  const fail = m => { throw Error(m); };
  const plural = (n, w, ws) => globalThis.AtriumI18n?.plural?.(n, w, ws || w + "s") ?? n + " " + (n === 1 ? w : ws || w + "s");

  // ---------------------------------------------------------------- hashing
  // Canonical JSON (sorted keys) so the same design always hashes the same.
  function canon(v) {
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (plain(v)) return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
    return JSON.stringify(v ?? null);
  }
  const hash = v => J().sha256(str(v) ? v : canon(v));
  // Fields that are history or UI state, never design input.
  const META = new Set(["outputJobs", "releases", "activeVariant", "review", "ui", "view", "history"]);
  function topLevel(project) { const out = {}; for (const [k, v] of Object.entries(project)) if (k !== "documents" && !META.has(k)) out[k] = v; return out; }
  // Hashes of the slices of the design each output reads: board, schematic, everything.
  function slices(project, board) {
    const top = topLevel(project), docs = project.documents || [];
    return {
      board: hash({top, board: board || null, panels: docs.filter(d => d.kind === "panel")}),
      schematic: hash({top, sheets: docs.filter(d => d.kind === "schematic")}),
      all: hash({top, docs})
    };
  }
  const designHash = project => hash({top: topLevel(project), docs: project.documents || []});
  function rulesHash(project, board) {
    const R = globalThis.AtriumRules;
    let rules = board ? globalThis.AtriumRules?.stored?.(board, project) ?? null : null;
    try { if (R?.effective && board) rules = R.effective(board, project) || rules; } catch { /* the stored rules */ }
    return hash(rules || {});
  }
  // Which slice of the design an output kind reads.
  const SLICE = {gerber: "board", pnp: "board", assembly: "board", ipc2581: "board", step: "board", notes: "board", drc: "board", erc: "schematic"};
  // Outputs that never change with the assembly variant (copper, drill, DRC).
  const VARIANT_FREE = new Set(["gerber", "drc"]);
  function inputHash(sl, kind, options, vars, variantKey) {
    const v = {...vars}; delete v.folder; delete v.job;
    return hash({kind, slice: sl[SLICE[kind] || "all"], options: options || {}, vars: v, variant: VARIANT_FREE.has(kind) ? null : variantKey ?? null, engine: J().VERSION});
  }
  // The public slices/inputHash helpers keep their original contract. Output caching uses
  // the runner's chosen board, panel and variant, and only fingerprints inputs a job reads.
  const MATCHED_PARTS = new Set(["gerber", "pnp", "assembly", "ipc2581", "step"]);
  function fingerprints(project, design) {
    const docs = project.documents || [], owners = new Map();
    let top, schematicParts, boardParts, boards;
    function owner(doc) {
      if (!doc) return null;
      if (!owners.has(doc)) owners.set(doc, hash(doc));
      return owners.get(doc);
    }
    const partsOf = kind => docs.filter(doc => doc.kind === kind).map(doc =>
      [doc.id, doc.name, (doc.items || []).filter(item => item.kind === "part")]);
    const full = () => design ??= designHash(project);
    function slice(kind, ctx) {
      if (!SLICE[kind]) return full();
      top ??= hash(topLevel(project));
      if (kind === "erc") {
        // ERC checks board placements against schematic parts. Scoped electrical rules
        // and calculated fields can also read board geometry.
        const scoped = ctx.calculationSnapshot || globalThis.AtriumERC?.usesBoardScopes?.(project);
        const pcb = scoped ? boards ??= ctx.boards.map(owner) : boardParts ??= hash(partsOf("pcb"));
        return hash([top, docs.filter(doc => doc.kind === "schematic").map(owner), pcb]);
      }
      // Panels may refer to more than one source board, by name or ID. Sign the
      // entire board list in document order so alias changes cannot reuse a panel.
      const panel = ctx.panel ? [owner(ctx.panel), boards ??= ctx.boards.map(owner)] : null;
      const linked = MATCHED_PARTS.has(kind) ? schematicParts ??= hash(partsOf("schematic")) : null;
      return hash([top, owner(ctx.board), panel, linked]);
    }
    return {slice, worker: () => hash([full(), project.activeVariant ?? null])};
  }

  function outputDate(kind, date) {
    if (kind === "pnp" || kind === "kicad") return null; // job variables already carry the local minute
    const iso = date.toISOString();
    if (kind === "assembly" || kind === "notes") return iso.slice(0, 10);
    if (["gerber", "ipc2581", "step", "drc", "erc", "bomcost"].includes(kind)) return iso.slice(0, 19);
    return iso;
  }
  function outputKey(inputs, out, ctx) {
    const vars = {...ctx.vars}, options = out.options || {};
    const templates = [options.name, options.pack].filter(str).join(" ");
    if (!templates.includes("{folder}")) delete vars.folder;
    if (!templates.includes("{job}")) delete vars.job;
    return hash({kind:out.kind, slice:inputs.slice(out.kind, ctx), options, vars, board:ctx.board?.id, panel:ctx.panel?.id,
      profile:ctx.fabProfile, date:outputDate(out.kind, ctx.date), active:options.variant === undefined ? ctx.project.activeVariant : undefined,
      engine:J().VERSION});
  }
  function createCache(limit = 200) {
    const map = new Map();
    return {
      get(k) { const v = map.get(k); if (v) { map.delete(k); map.set(k, v); } return v; },
      set(k, v) { map.set(k, v); while (map.size > limit) map.delete(map.keys().next().value); },
      clear() { map.clear(); }, get size() { return map.size; }
    };
  }

  // ---------------------------------------------------------------- names and variants
  const V = () => globalThis.AtriumVariants;
  const variantList = project => V()?.list(project) || (Array.isArray(project?.variants) ? project.variants.filter(v => plain(v) && str(v.id)) : []);
  function targets(project, set, choice) {
    const want = choice ?? set?.variants ?? "active", all = variantList(project);
    const byName = ref => all.find(v => v.id === ref || String(v.name).trim().toLowerCase() === String(ref).trim().toLowerCase());
    if (!all.length) return [{ref: undefined, key: "", name: ""}];
    if (want === "base") return [{ref: null, key: "base", name: "Base"}];
    if (want === "all") return [{ref: null, key: "base", name: "Base"}, ...all.map(v => ({ref: v.id, key: v.id, name: v.name}))];
    if (Array.isArray(want)) return want.map(n => {
      if (n === "" || n === null || String(n).toLowerCase() === "base") return {ref: null, key: "base", name: "Base"};
      const v = byName(n) || fail("There is no assembly variant called " + n + ". Variants: " + all.map(x => x.name).join(", ") + ".");
      return {ref: v.id, key: v.id, name: v.name};
    });
    const active = byName(project.activeVariant);
    return [active ? {ref: active.id, key: active.id, name: active.name} : {ref: null, key: "base", name: "Base"}];
  }
  function outputsFor(project, outputs, target) {
    const fabrication = new Map();
    return outputs.map(out => {
      const original = out.options?.variant, requested = out.options && "variant" in out.options ? original : target.ref;
      let variant = requested === "" ? null : requested;
      if (out.kind === "gerber" && variant != null) {
        if (!fabrication.has(variant)) {
          const record = V()?.find(project, variant);
          const assemblyOnly = record && Object.values(record.parts || {}).every(entry => !entry?.alternate && !entry?.params);
          fabrication.set(variant, assemblyOnly ? null : variant);
        }
        // A fit-only assembly variant has no manufacturing changes. Render Gerbers
        // from the base explicitly so the fabrication README and warnings agree too.
        variant = fabrication.get(variant);
      }
      return variant === original ? out : {...out, options:{...out.options, variant}};
    });
  }
  function revisionOf(project, set, opts = {}) {
    const hook = v => str(v) && v.trim() ? v.trim() : plain(v) && str(v.letter) && v.letter.trim() ? v.letter.trim() : null;
    const param = o => o?.parameters && (o.parameters.Revision ?? o.parameters.REVISION ?? o.parameters.Rev);
    const board = (project.documents || []).find(d => d.kind === "pcb" && (!set?.board || d.id === set.board));
    return String(opts.revision ?? set?.revision ?? hook(project.revision) ?? param(project) ?? param(board) ?? "1");
  }
  const dateOf = d => d instanceof Date ? d : d ? new Date(d) : new Date();
  function packageName(project, set, o = {}) {
    const date = dateOf(o.date), parts = [project.name || "Project", revisionOf(project, set, o)];
    if (o.variant) parts.push(o.variant);
    parts.push(J().dateText(date));
    return J().joinPath(parts.map(p => J().safe(p).replace(/\//g, "-")).join("-"));
  }

  // ---------------------------------------------------------------- pre-flight
  const boardOf = (project, set) => { const b = (project.documents || []).filter(d => d.kind === "pcb"); return set?.board ? b.find(d => d.id === set.board) || null : b[0] || null; };
  const check = (id, label, status, summary, items = [], fix = null) => ({id, label, status, summary, items: items.slice(0, 50), more: Math.max(0, items.length - 50), fix});
  function drcCheck(project, set) {
    const board = boardOf(project, set);
    if (!board) return check("drc", "Design rules (DRC)", "skip", "The project has no board layout.");
    const R = globalThis.AtriumRules;
    if (!R) return check("drc", "Design rules (DRC)", "skip", "The rules engine is not loaded.");
    const prepared = R.reportInput(board, {project, limit: 200});
    const result = prepared.result, waived = prepared.waived.length;
    const items = result.violations.map(v => ({text: (v.ruleName ? v.ruleName + ": " : "") + (v.title || v.what || v.type), target: {doc: board.id, id: v.id || null, at: v.at || null}}));
    const extra = waived ? " (" + waived + " waived)" : "";
    return check("drc", "Design rules (DRC)", result.total ? "fail" : "pass", result.total ? plural(result.total, "violation") + extra + " on " + board.name + "." : "No violations" + extra + " on " + board.name + ".", items,
      {action: "drc", label: "Open DRC"});
  }
  function ercCheck(project, calculationSnapshot) {
    const E = globalThis.AtriumERC;
    if (!(project.documents || []).some(d => d.kind === "schematic")) return check("erc", "Electrical rules (ERC)", "skip", "The project has no schematic.");
    if (!E) return check("erc", "Electrical rules (ERC)", "skip", "The electrical rules check is not loaded.");
    const r = E.run(project, calculationSnapshot ? {calculationSnapshot} : undefined);
    const C = globalThis.AtriumChecks, W = globalThis.AtriumWaivers;
    const assertions = C && W ? r.messages.filter(m => m.check === "calculationAssertion" && !m.detail?.scopeDiagnostic).map(m => C.fromERC(m)).filter(Boolean) : [];
    const waived = new Set(assertions.length ? W.match(project, assertions).waived.map(x => x.violation.raw) : []);
    const msgs = r.messages.filter(m => m.check !== "summary" && !waived.has(m));
    const errors = msgs.filter(m => m.class === "Fatal" || m.class === "Error"), warns = msgs.filter(m => m.class === "Warning");
    const items = [...errors, ...warns].map(m => ({text: m.class + ": " + m.text, level: m.class === "Warning" ? "warn" : "fail", target: {doc: m.documentId || null, id: m.objectId || null, at: m.point || null}}));
    return check("erc", "Electrical rules (ERC)", errors.length ? "fail" : warns.length ? "warn" : "pass",
      errors.length ? plural(errors.length, "error") + (warns.length ? ", " + plural(warns.length, "warning") : "") + "." : warns.length ? plural(warns.length, "warning") + ", no errors." : "No errors or warnings.",
      items, {action: "compile", label: "Open Messages"});
  }
  function bomCheck(project, set, tgts) {
    const B = globalThis.AtriumBOM;
    if (!B) return check("bom", "BOM completeness", "skip", "The bill of materials module is not loaded.");
    const vendor = set?.package?.mode === "vendor" ? set.package.vendor : null, items = [];
    let lines = 0, missing = 0, dup = 0, mismatch = 0, lcsc = 0;
    for (const t of tgts) {
      let p = project;
      try { p = V() && t.ref !== undefined ? V().forOutput(project, t.ref) : project; } catch { /* the variant check reports it */ }
      const collected = B.collect(p, {}), rows = B.build(collected, {});
      const tag = tgts.length > 1 ? " [" + t.name + "]" : "";
      for (const r of rows) {
        if (r.dnp) continue;
        lines++;
        const refs = r.refs.join(", "), target = {doc: r.parts[0]?.docId || null, id: r.parts[0]?.id || null};
        if (r.status.includes("missing-mpn")) { missing++; items.push({text: refs + " (" + (r.values.comment || "no comment") + "): no manufacturer part number" + tag, level: "warn", target}); }
        if (r.status.includes("duplicate")) { dup++; items.push({text: refs + ": duplicate designator" + tag, level: "fail", target}); }
        if (r.status.includes("mismatch")) { mismatch++; items.push({text: refs + ": the board differs from the schematic" + tag, level: "warn", target}); }
        if (vendor === "JLCPCB" && !r.parts.some(x => /^C\d{3,10}$/i.test(String(x.supplierPn || x.params?.["LCSC #"] || x.params?.LCSC || "").trim()))) lcsc++;
      }
      for (const m of collected.mismatches || []) if (m.kind === "schematic-only" || m.kind === "board-only") { mismatch++; items.push({text: m.ref + (m.kind === "schematic-only" ? " is on the schematic but not on the board" : " is on the board but not on the schematic") + tag, level: "warn", target: null}); }
    }
    if (lcsc) items.push({text: plural(lcsc, "BOM line") + " have no LCSC part number, so JLCPCB cannot assemble them.", level: "warn", target: null});
    const parts = [missing && plural(missing, "line") + " without an MPN", dup && plural(dup, "duplicate designator"), mismatch && plural(mismatch, "schematic/board difference"), lcsc && lcsc + " without an LCSC number"].filter(Boolean);
    return check("bom", "BOM completeness", dup ? "fail" : parts.length ? "warn" : "pass", parts.length ? parts.join(", ") + " (" + plural(lines, "fitted line") + ")." : "Every fitted line has a part number (" + plural(lines, "line") + ").", items,
      {action: "bom", label: "Open BOM"});
  }
  function variantCheck(project, set, choice) {
    const all = variantList(project);
    if (!all.length) return check("variants", "Assembly variants", "skip", "The project has no assembly variants.");
    let tgts;
    try { tgts = targets(project, set, choice); } catch (e) { return check("variants", "Assembly variants", "fail", e.message, [], {action: "variants", label: "Open Variants"}); }
    const keys = new Set(), defs = new Set(project.library.map(d => d.id)), items = [];
    for (const d of project.documents || []) for (const i of d.items || []) if (i.kind === "part") keys.add(i.link || i.id);
    for (const t of tgts) {
      const v = all.find(x => x.id === t.ref);
      if (!v) continue;
      const entries = Object.entries(v.parts || {});
      const stale = entries.filter(([k]) => !keys.has(k)).length;
      if (stale) items.push({text: v.name + ": " + plural(stale, "entry", "entries") + " name parts that are no longer in the design.", level: "warn", target: null});
      for (const [k, e] of entries) if (e?.alternate?.def && !defs.has(e.alternate.def)) items.push({text: v.name + ": the alternate part for " + k + " is not in the library.", level: "fail", target: null});
      try { V()?.resolve?.(project, v.id); } catch (err) { items.push({text: v.name + ": " + err.message, level: "fail", target: null}); }
    }
    const failed = items.some(i => i.level === "fail");
    return check("variants", "Assembly variants", failed ? "fail" : items.length ? "warn" : "pass",
      (failed ? "Problems in " : items.length ? "Stale entries in " : "Checked ") + tgts.map(t => t.name).join(", ") + ".", items, {action: "variants", label: "Open Variants"});
  }
  // Placeholders (placeholder-parts.js): an unresolved one is a warning that names it (a provisional
  // footprint fabricates normally); one with no footprint at all fails, since the board would lack it.
  // A set with gates.placeholders "block" (the "Release (placeholders resolved)" preset) fails on any.
  function placeholderCheck(project, set) {
    const defs = new Map((project.library || []).map(d => [d.id, d])), items = [], seen = new Set(), strict = set.gates?.placeholders === "block";
    for (const d of project.documents || []) if (d.kind === "schematic") for (const i of d.items || []) {
      const def = i.kind === "part" ? defs.get(i.def) : null;
      if (def?.generic?.role !== "placeholder" || seen.has(i.ref)) continue;
      seen.add(i.ref);
      const none = !def.footprint;
      items.push({text: i.ref + " (" + (def.generic.family || "placeholder") + ") " + (none ? "has no footprint: resolve it or choose a provisional package." : "has a provisional " + (def.generic.package || def.footprint.name) + " footprint."),
        level: none || strict ? "fail" : "warn", target: {doc: d.id, id: i.id, at: [i.x, i.y]}});
    }
    if (!items.length) return check("placeholders", GATE_LABEL.placeholders, "pass", "No unresolved placeholders.");
    const failed = items.some(i => i.level === "fail");
    return check("placeholders", GATE_LABEL.placeholders, failed ? "fail" : "warn", plural(items.length, "placeholder") + " not resolved" + (strict ? " (this job set requires every placeholder resolved)" : "") + ": " +
      items.slice(0, 6).map(i => i.text.split(" ")[0]).join(", ") + (items.length > 6 ? "…" : "") + ".", items, {action: "placeholder-resolve", label: "Resolve…"});
  }
  function gitCheck(opts) {
    const items = [];
    if (opts.unsaved) items.push({text: "The project has unsaved changes: the release is made from the open design, not the saved file.", level: "fail", target: null});
    const g = opts.git;
    if (!g || g.available === false) return check("git", "Saved and committed", items.length ? "fail" : "skip", items.length ? "Unsaved changes. " + (g?.reason || "No Git repository.") : (g?.reason || "No Git repository: the release records no commit."), items,
      items.length ? {action: "save", label: "Save"} : null);
    if (g.dirty) items.push({text: "The saved project differs from Git commit " + String(g.commit || "").slice(0, 10) + ".", level: "fail", target: null});
    if (g.conflicted) items.push({text: "The project has unresolved merge conflicts.", level: "fail", target: null});
    return check("git", "Saved and committed", items.length ? "fail" : "pass", items.length ? items.map(i => i.text).join(" ") : "Committed at " + String(g.commit || "").slice(0, 10) + (g.branch ? " on " + g.branch : "") + ".", items,
      items.length ? {action: opts.unsaved ? "save" : "history", label: opts.unsaved ? "Save" : "Open History"} : null);
  }
  function outputsCheck(set) {
    const K = J().KINDS, items = [];
    for (const o of set.outputs) if (o.enabled && K[o.kind]?.needs && !globalThis[K[o.kind].needs] && !["pdf", "drawing"].includes(o.kind)) items.push({text: (o.label || K[o.kind].label) + " is not available in this build.", level: "warn", target: null});
    if (!set.outputs.some(o => o.enabled)) items.push({text: "Every output is switched off.", level: "fail", target: null});
    return check("outputs", "Outputs", items.some(i => i.level === "fail") ? "fail" : items.length ? "warn" : "pass", items.length ? items[0].text : plural(set.outputs.filter(o => o.enabled).length, "output") + " switched on.", items);
  }
  const GATE_LABEL = {drc: "Design rules (DRC)", erc: "Electrical rules (ERC)", bom: "BOM completeness", variants: "Assembly variants", git: "Saved and committed", dfm: "Manufacturability (DFM)" /* fab-presets */, placeholders: "Placeholders resolved"};
  function preflight(project, ref, opts = {}) {
    const set = J().resolve(project, ref, opts), off = set.gates || {}, choice = opts.variants ?? set.variants;
    let tgts;
    try { tgts = targets(project, set, choice); } catch { tgts = [{ref: undefined, key: "", name: ""}]; }
    const run = (id, fn) => {
      if (off[id] === false) return check(id, GATE_LABEL[id], "skip", "Turned off for this job set.");
      try { return fn(); } catch (e) { return check(id, GATE_LABEL[id], "fail", "The check could not run: " + e.message); }
    };
    const checks = [run("drc", () => drcCheck(project, set)), run("erc", () => ercCheck(project, opts.calculationSnapshot)), run("bom", () => bomCheck(project, set, tgts)),
      run("variants", () => variantCheck(project, set, choice)), run("placeholders", () => placeholderCheck(project, set)), run("git", () => gitCheck(opts)),
      // fab-presets: DFM against the board's fab preset (dfm.js); absent when no preset applies.
      ...(globalThis.AtriumDFM?.releaseGate ? [run("dfm", () => AtriumDFM.releaseGate(project, set, check))].filter(Boolean) : []), outputsCheck(set)];
    return {checks, ok: !checks.some(c => c.status === "fail"), targets: tgts};
  }
  async function preflightAsync(project, ref, opts = {}) {
    const set = J().resolve(project, ref, opts);
    const calculationSnapshot = set.gates?.erc === false ? null :
      await globalThis.AtriumERC?.prepareCalculations?.(project, {signal: opts.signal});
    return preflight(project, set, {...opts, calculationSnapshot});
  }
  // Failed checks that no override (with a reason) covers.
  function blocking(checks, overrides = []) {
    const ok = new Set(overrides.filter(o => o && str(o.check) && str(o.reason) && o.reason.trim()).map(o => o.check));
    return checks.filter(c => c.status === "fail" && !ok.has(c.id));
  }

  // ---------------------------------------------------------------- generating
  // The ODB++ writer lives in the translator worker. The file-script worker services the older generators.
  const FILE_WORKER_KINDS = new Set(["gerber", "ipc2581", "step", "kicad", "pnp", "assembly"]);
  const WORKER_KINDS = new Set([...FILE_WORKER_KINDS, "odb"]);
  const WORKER_GLOBALS = globalThis.AtriumReleaseWorkerModules;
  let workerUrl = null;
  try { workerUrl = typeof document !== "undefined" && document.currentScript?.src ? new URL("../workers/release-worker.js", document.currentScript.src).href : null; } catch { workerUrl = null; }
  // A worker that does not report its scripts loaded in this long is given up (the page makes the outputs).
  const START_MS = 15000;
  // One worker per release run; it keeps the project and the fabrication model between outputs.
  // Started through AtriumWorkerPool.script() (worker-pool.js, a lazy dependency): WKWebView and
  // WebKitGTK never start a worker from the file:// URL itself.
  function startWorker(project) {
    if (!workerUrl || typeof Worker !== "function" || !WORKER_GLOBALS) return null;
    const want = WORKER_GLOBALS.filter(([g]) => globalThis[g]).map(([g]) => g);
    let w;
    try { w = globalThis.AtriumWorkerPool?.script ? globalThis.AtriumWorkerPool.script(workerUrl) : new Worker(workerUrl); } catch { return null; }
    let seq = 0, broken = false, reason = "";
    const waiting = new Map();
    const ready = new Promise(resolve => {
      const give = why => { if (!broken) reason = why; broken = true; clearTimeout(dog); resolve(false); };
      const dog = setTimeout(() => { give("it did not start within " + START_MS / 1000 + " s"); try { w.terminate(); } catch { /* gone */ } }, START_MS);
      w.onmessage = e => {
        const m = e.data || {};
        if (m.type === "ready") {
          clearTimeout(dog);
          const missing = want.filter(g => !(m.globals || []).includes(g));
          if (missing.length) give("it could not load " + missing.join(", ")); else resolve(true);
        } else if (m.type === "result" && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); m.error ? p.reject(Error(m.error)) : p.resolve(m.result); }
      };
      w.onerror = e => { e.preventDefault?.(); give(e.message || "it stopped"); for (const p of waiting.values()) p.reject(Error("The output worker stopped.")); waiting.clear(); };
      try { w.postMessage({type: "init", globals: want}); } catch (e) { give(String(e?.message || e)); }
    });
    let version = null;
    const setProject = (p, v) => {
      if (broken || v === version) return;
      try { w.postMessage({type: "project", project: p}); version = v; } catch { broken = true; }
    };
    if (project) setProject(project, "first");
    return {
      ready, setProject, get broken() { return broken; }, get reason() { return reason; },
      async run(set, out, opts) {
        if (broken || !await ready) throw Error("No worker.");
        const id = ++seq;
        // A watchdog: an output the worker has not answered in five minutes is made on the page instead.
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => { if (waiting.delete(id)) reject(Error("The output worker did not answer.")); }, 300000);
          waiting.set(id, {resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }});
          w.postMessage({type: "run", id, set, out, opts});
        });
      },
      stop() { try { w.terminate(); } catch { /* gone */ } for (const p of waiting.values()) p.reject(Error("Cancelled.")); waiting.clear(); broken = true; }
    };
  }
  // A worker kept between runs (the Release page): scripts load once, the project is sent again
  // only when the design changed, and cancel() ends a run in flight (the next run starts a new one).
  function workerPool() {
    let inner = null;
    return {
      for(project, version) {
        if (!inner || inner.broken) inner = startWorker(null);
        inner?.setProject(project, version);
        return inner;
      },
      cancel() { inner?.stop(); inner = null; },
      close() { inner?.stop(); inner = null; }
    };
  }
  const translatorWorker = () => !!globalThis.document && !!globalThis.AtriumLazy;
  function workerFor(opts, project, inputs) {
    let started = false, worker;
    return {
      get() {
        if (!started) {
          started = true;
          if (typeof opts.worker?.for === "function") worker = opts.worker.for(project, inputs.worker());
          else if (opts.worker === true) worker = startWorker(project);
        }
        return worker;
      },
      stop() { if (opts.worker === true) worker?.stop(); }
    };
  }
  function currentDesign(project, settling = false) {
    const host = globalThis.AtriumNavHost;
    if (!host || host.project?.() !== project) return () => true;
    const revision = host.authoredRevision || (settling ? null : host.revision);
    const stamp = revision?.();
    return () => globalThis.AtriumNavHost?.project?.() === project && (!revision || revision() === stamp);
  }
  // The runAsync hook: an output comes from the cache, else the worker, else the page.
  function interceptor({inputs, cache, workers, stats, set, date, revision, current, signal, provenance}) {
    // Retained import records can change without a corresponding editable design revision.
    const retainedSource = Array.isArray(provenance) ? provenance.some(Boolean) : !!provenance;
    let translation;
    const intercept = async (out, ctx, fallback, effective = ctx) => {
      if (signal?.aborted || !current()) return {skip: "Cancelled."};
      const canOffload = WORKER_KINDS.has(out.kind), translated = canOffload && translatorWorker();
      const host = globalThis.AtriumNavHost;
      // A folder's translator can discover retained records even before the caller has loaded them.
      const folder = translated && host?.project?.() === effective.project ? host.folderProject?.() : null;
      const key = canOffload && (retainedSource || folder?.hasImportIndexes?.()) ? null : outputKey(inputs, out, ctx);
      const hit = key && cache.get(key);
      if (hit) { stats.cached++; return {res: copyResult(hit), cached: true}; }
      // The file worker only receives the editable project and job options.
      const worker = !translated && !ctx.panel && !retainedSource && FILE_WORKER_KINDS.has(out.kind) ? workers.get() : null;
      let res = null;
      if (translated) {
        const client = await AtriumLazy.need("AtriumTranslatorClient");
        translation ??= client.exportSession?.();
        const request = J().translatedOutput(effective, out, (id, model, options) =>
          (translation || client).export(id,model,{...options,provenance,signal}));
        res = request.pending ? await request.pending : request;
        stats.worker++;
      } else if (worker) {
        try { res = await worker.run({...set, outputs: [out]}, out, {date: date.toISOString(), revision}); }
        catch (e) { if (signal?.aborted) return {skip: "Cancelled."}; res = null; stats.workerError ||= worker.reason ? "The output worker could not start: " + worker.reason + "." : String(e?.message || e); }
        // An output the worker could not make is made again on the page, so a release is never short
        // of an output the page can make; the page's result (or error) is the one kept.
        if (res?.status === "error") { stats.workerError ||= (out.label || out.kind) + ": " + (res.message || "failed in the output worker") + "."; res = null; }
        if (res) stats.worker++;
      }
      if (!res) {
        const p = fallback();
        if (!p.res) return p;
        res = p.res.pending ? await p.res.pending : p.res;
        stats.page++;
      }
      if (signal?.aborted || !current()) return {skip: "Cancelled."};
      if (key && res.status !== "error" && res.status !== "skipped") cache.set(key, copyResult(res));
      return {res};
    };
    return Object.assign(intercept,{close:()=>translation?.close()});
  }
  // Pours can advance the derived revision. An authoring change invalidates the invocation
  // before its label, fingerprints or worker snapshot are captured.
  async function captureRun(project, opts, {subject, settle, date = opts.date, changed}, body) {
    const sameDesign = currentDesign(project, true);
    if (settle) await J().settle?.(project, subject, {date, odbEnabled: opts.odbEnabled, signal: opts.signal}, opts.progress);
    if (!sameDesign()) fail(changed);
    const current = currentDesign(project), stats = {cached: 0, worker: 0, page: 0};
    let inputs, cache, workers;
    async function run(set, {date, revision, progress, changed, design}) {
      if (!workers) {
        cache = opts.cache || createCache();
        inputs = fingerprints(project, design);
        workers = workerFor(opts, project, inputs);
      }
      const intercept = interceptor({inputs, cache, workers, stats, set, date, revision, current, signal: opts.signal, provenance: opts.provenance});
      try {
        const produced = await J().runAsync(project, set, {date, revision, intercept, signal: opts.signal, settle: false,
          odbEnabled: opts.odbEnabled, provenance: opts.provenance}, progress);
        if (!current()) fail(changed);
        return produced;
      } finally { intercept.close(); }
    }
    try { return await body({current, run, stats}); }
    finally { workers?.stop(); }
  }
  // A preview run of one job set (the Release page's cards): no gates, no manifest, the same cache.
  async function generate(project, ref, opts = {}) {
    const base = J().resolve(project, ref, opts), date = dateOf(opts.date);
    const tg = targets(project, base, opts.variant !== undefined ? [opts.variant ?? "base"] : "active")[0];
    const set = {...base, zip: false, package: base.package?.mode === "zip" ? {mode: "folder"} : base.package,
      outputs: outputsFor(project, base.outputs, tg)};
    // An already cancelled preview still reports which outputs were skipped.
    const changed = "The design changed while generating outputs.";
    return captureRun(project, opts, {subject: set, settle: !opts.signal?.aborted, date, changed}, async ({run, stats}) => {
      const revision = revisionOf(project, base, opts);
      const produced = await run(set, {date, revision, progress: opts.progress, changed});
      return {...produced, stats};
    });
  }
  const copyResult = r => ({...r, files: (r.files || []).map(f => ({name: f.name, data: f.data})), warnings: [...(r.warnings || [])]});

  // A hash that ignores what changes on every run: dates and times, and the SHA-256 lines that
  // list other files. Two releases of the same design on different days get the same stable hash,
  // so Compare shows real changes. Stored ZIPs (Gerber packs, xlsx) hash their entries' stable hashes.
  const DATES = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:?\d{2}(?::?\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|D:\d{8,14}(?:[-+Z][\d']*)?|\b[0-9a-f]{64}\b|\b\d{8}T?\d{4,6}\b/g;
  function latin1(b) { let t = ""; for (let i = 0; i < b.length; i += 8192) t += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return t; }
  function stableHash(data, depth = 0) {
    const b = J().bytesOf(data);
    if (depth < 2 && b.length > 22 && b[0] === 0x50 && b[1] === 0x4b) {
      const parts = storedEntries(b);
      if (parts) return J().sha256(parts.map(e => e.name + ":" + stableHash(e.data, depth + 1)).join("\n"));
    }
    const head = b.subarray(0, 4096);
    if (head.includes(0) && !/^%PDF/.test(latin1(b.subarray(0, 5)))) return J().sha256(b);
    return J().sha256(latin1(b).replace(DATES, "#"));
  }
  // Stored (uncompressed) entries only. ZIP limits as AtriumSexpr.unzip (sexpr.js): at most 10000
  // entries and 512 MB in all (entries may overlap, so the sum is capped), each inside the file.
  function storedEntries(b) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [], floor = Math.max(0, b.length - 65557);
    let end = b.length - 22, total = 0;
    while (end >= floor && v.getUint32(end, true) !== 0x06054b50) end--;
    if (end < floor || v.getUint16(end + 10, true) > 10000) return null;
    let cd = v.getUint32(end + 16, true);
    for (let i = 0, n = v.getUint16(end + 10, true); i < n; i++) {
      if (cd + 46 > b.length) return null;
      const method = v.getUint16(cd + 10, true), size = v.getUint32(cd + 20, true), nl = v.getUint16(cd + 28, true), local = v.getUint32(cd + 42, true);
      if (method !== 0 || local + 30 > b.length) return null;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      if (start + size > b.length || (total += size) > 512 * 1024 * 1024) return null;
      out.push({name: latin1(b.subarray(cd + 46, cd + 46 + nl)), data: b.subarray(start, start + size)});
      cd += 46 + nl + v.getUint16(cd + 30, true) + v.getUint16(cd + 32, true);
    }
    return out;
  }

  // ---------------------------------------------------------------- manifest
  // The app version (about.js); headless hosts pass opts.toolVersion (the MCP reads about.js).
  let hostVersion = null;
  const toolVersion = () => globalThis.AtriumAbout?.VERSION || hostVersion || "dev";
  function waiversOf(project) {
    const out = [];
    for (const d of project.documents || []) if (d.kind === "pcb" && Array.isArray(d.drcWaivers)) for (const w of d.drcWaivers.slice(0, 500))
      out.push({board: d.name, id: w.id, rule: w.rule || w.ruleName || w.type || null, note: str(w.note) ? w.note.slice(0, 500) : "", objects: Array.isArray(w.objects) ? w.objects.slice(0, 20) : []});
    return out;
  }
  function bomSnapshot(project) {
    const B = globalThis.AtriumBOM;
    if (!B) return null;
    try {
      const rows = B.build(B.collect(project, {}), {});
      return rows.slice(0, 2000).map(r => [r.refs.join(","), String(r.values.comment ?? ""), String(r.values.footprint ?? ""), r.parts.find(p => p.mpn)?.mpn || "", r.dnp ? 1 : 0]);
    } catch { return null; }
  }
  const esc = s => String(s ?? "").replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/\r?\n/g, " ");
  function releaseMarkdown(m) {
    const L = [];
    L.push("# " + esc(m.name), "", "| | |", "|---|---|", "| Project | " + esc(m.project) + " |", "| Revision | " + esc(m.revision) + " |");
    if (m.variant) L.push("| Variant | " + esc(m.variant.name) + " |");
    L.push("| Date | " + m.date + " |", "| Job set | " + esc(m.job.name) + (m.job.preset ? " (preset)" : m.job.from ? " (from " + esc(m.job.from) + ")" : "") + " |",
      "| Package | " + m.package.mode + (m.package.vendor ? " (" + esc(m.package.vendor) + ")" : "") + " |",
      "| Waffle | " + esc(m.tool.version) + " |", "| Git commit | " + (m.git?.commit ? m.git.commit + (m.git.branch ? " (" + esc(m.git.branch) + ")" : "") + (m.git.dirty ? ", uncommitted changes" : "") : "none") + " |",
      "| Rules hash | " + m.rulesHash.slice(0, 16) + " |", "| Design hash | " + m.designHash.slice(0, 16) + " |", "");
    if (m.notes) L.push("## Notes", "", esc(m.notes), "");
    L.push("## Pre-flight", "");
    for (const g of m.gates) {
      const o = m.overrides.find(x => x.check === g.id);
      L.push("- " + (g.status === "pass" ? "[x]" : g.status === "skip" ? "[-]" : "[ ]") + " **" + esc(g.label) + "**: " + esc(g.summary) + (o ? " *Overridden: " + esc(o.reason) + "*" : ""));
    }
    L.push("");
    if (m.waivers.length) { L.push("## DRC waivers", ""); for (const w of m.waivers) L.push("- " + esc(w.board) + ": " + esc(w.rule || "rule") + (w.note ? ": " + esc(w.note) : "")); L.push(""); }
    L.push("## Outputs", "", "| Output | Status | Summary |", "|---|---|---|");
    for (const o of m.outputs) L.push("| " + esc(o.label) + " | " + o.status + " | " + esc([o.summary, o.message].filter(Boolean).join(" — ")) + " |");
    L.push("", "## Files", "", "| File | Bytes | SHA-256 |", "|---|---:|---|");
    for (const f of m.files) L.push("| " + esc(f.path) + " | " + f.bytes + " | `" + f.sha256 + "` |");
    L.push("", "release.json has the same facts in machine-readable form. Check the files with `shasum -a 256` (macOS) or `sha256sum` (Linux).", "");
    return L.join("\n");
  }

  // ---------------------------------------------------------------- release
  // The release steps as a generator: it yields one job run per variant ({set, tg, t}) and gets the
  // run back, so release() (asynchronous: cache, worker, progress, cancel) and releaseSync()
  // (headless MCP) share every other line.
  function* steps(project, ref, opts) {
    if (!project || !Array.isArray(project.documents)) fail("Open a project first.");
    const Jo = J(), base = Jo.resolve(project, ref, opts), date = dateOf(opts.date);
    if (!Number.isFinite(date.getTime())) fail("Use an ISO 8601 date such as 2026-01-31T12:00:00Z.");
    const pf = opts.preflight || preflight(project, base, opts), overrides = (opts.overrides || []).filter(o => o && str(o.check) && str(o.reason) && o.reason.trim()).map(o => ({check: o.check, reason: o.reason.trim().slice(0, 500)}));
    const blocked = blocking(pf.checks, overrides);
    if (str(opts.toolVersion) && /^[\w.+-]{1,40}$/.test(opts.toolVersion)) hostVersion = opts.toolVersion;
    if (blocked.length && opts.force !== true) fail("Pre-flight failed: " + blocked.map(c => c.label + " (" + c.summary + ")").join("; ") + " Fix it, or override it with a reason.");
    const tgts = targets(project, base, opts.variants ?? base.variants), named = variantList(project).length > 0;
    const revision = revisionOf(project, base, opts), designH = designHash(project), rulesH = rulesHash(project, boardOf(project, base));
    const packages = [], files = [];
    {
      for (let t = 0; t < tgts.length; t++) {
        const tg = tgts[t], name = packageName(project, base, {...opts, date, revision, variant: named ? tg.name : ""});
        const zip = base.package?.mode === "zip";
        // The job's own folder becomes the package; outputs run on this variant unless they pin one.
        const set = {...base, folder: name, zip: false, package: zip ? {mode: "folder"} : base.package,
          outputs: outputsFor(project, base.outputs, tg)};
        const run = yield {set, tg, t, date, revision, designH, count: tgts.length};
        if (opts.signal?.aborted) fail("Cancelled.");
        const r = run.report;
        const fileRows = [], dataOf = new Map(run.files.map(f => [f.name, f.data]));
        for (const f of r.outputs) for (const x of f.files) fileRows.push({path: x.name, bytes: x.bytes, sha256: x.sha256, stable: stableHash(dataOf.get(name + "/" + x.name) ?? ""), output: f.id});
        const gates = pf.checks.map(c => ({id: c.id, label: c.label, status: c.status, summary: c.summary}));
        const vp = tg.ref === undefined ? project : (V()?.forOutput(project, tg.ref) || project);
        const manifest = {format: "atrium-release", version: VERSION, name, project: project.name || "Project", revision, variant: named ? {id: tg.ref ?? null, name: tg.name} : null,
          date: date.toISOString(), job: {name: base.name, preset: !!base.preset, from: base.from || null}, package: {...base.package},
          tool: {name: "Waffle", version: toolVersion()}, git: opts.git && opts.git.available !== false ? {commit: opts.git.commit || null, branch: opts.git.branch || null, dirty: !!opts.git.dirty} : null,
          rulesHash: rulesH, designHash: designH, gates, overrides, waivers: waiversOf(project), notes: str(opts.notes) ? opts.notes.slice(0, 4000) : "",
          // A gate output (DRC/ERC report over its limit) whose check was overridden does not fail the package.
          ok: !blocked.length && r.outputs.every(o => o.status !== "error" && (o.status !== "failed" || overrides.some(v => v.check === o.kind))), outputs: r.outputs.map(o => ({id: o.id, kind: o.kind, label: o.label, status: o.status, summary: o.summary, message: o.message, warnings: o.warnings.slice(0, 50)})),
          files: fileRows};
        const md = releaseMarkdown(manifest), mdBytes = Jo.utf8(md);
        manifest.files = [...fileRows, {path: "RELEASE.md", bytes: mdBytes.length, sha256: Jo.sha256(mdBytes), output: "release"}];
        const json = JSON.stringify(manifest, null, 2) + "\n";
        let out;
        if (zip) {
          const all = [...run.files, {name: name + "/RELEASE.md", data: mdBytes}, {name: name + "/release.json", data: json}];
          const data = globalThis.AtriumZip.create(all.map(e => ({name: e.name, data: e.data})), {date});
          out = [{name: name + ".zip", data}];
        } else out = [...run.files, {name: name + "/RELEASE.md", data: mdBytes}, {name: name + "/release.json", data: json}];
        const pkg = {variant: named ? tg.name : null, name, ok: manifest.ok, report: r, manifest, files: out.map(f => ({name: f.name, bytes: Jo.bytesOf(f.data).length, sha256: Jo.sha256(f.data)})),
          bom: bomSnapshot(vp)};
        packages.push(pkg);
        files.push(...out);
      }
    }
    const name = packages.length === 1 ? packages[0].name : packageName(project, base, {...opts, date, revision});
    const record = {id: "r" + Jo.sha256(name + date.toISOString() + designH).slice(0, 12), name, date: date.toISOString(), revision, job: base.name, from: base.from || (base.preset ? base.name : null),
      package: {...base.package}, tool: toolVersion(), git: packages[0]?.manifest.git || null, rulesHash: rulesH, designHash: designH, notes: str(opts.notes) ? opts.notes.slice(0, 4000) : "",
      overrides, gates: pf.checks.map(c => ({id: c.id, status: c.status, summary: c.summary})), ok: packages.every(p => p.ok),
      packages: packages.map(p => ({variant: p.variant, name: p.name, ok: p.ok, files: p.manifest.files.slice(0, MAX_FILES).map(f => ({path: f.path, bytes: f.bytes, sha256: f.sha256, ...(f.stable ? {stable: f.stable} : {})})),
        archive: p.files.length === 1 && /\.zip$/.test(p.files[0].name) ? p.files[0] : null, bom: p.bom}))};
    return {name, ok: record.ok, packages, files: opts.files === false ? files.map(f => ({name: f.name})) : files, record};
  }
  async function release(project, ref, opts = {}) {
    const changed = "The design changed while preparing the release.";
    return captureRun(project, opts, {subject: ref, settle: Array.isArray(project?.documents), changed}, async ({current, run, stats}) => {
      if (!opts.preflight) opts = {...opts, preflight: await preflightAsync(project, ref, opts)};
      if (!current()) fail(changed);
      const g = steps(project, ref, opts);
      let step = g.next();
      while (!step.done) {
        const {set, tg, t, date, revision, designH, count} = step.value;
        const n = set.outputs.length, progress = e => opts.progress?.({...e, variant: tg.name, index: t * n + e.index, total: n * count});
        step = g.next(await run(set, {date, revision, progress, changed: "The design changed while making the release.", design: designH}));
      }
      return {...step.value, stats};
    });
  }
  // The same release, synchronous and without the cache or worker (MCP, scripts).
  function releaseSync(project, ref, opts = {}) {
    const g = steps(project, ref, opts);
    let step = g.next();
    while (!step.done) {
      const {set,date,revision}=step.value;
      step=g.next(J().run(project,set,{date,revision,odbEnabled:opts.odbEnabled,provenance:opts.provenance}));
    }
    return step.value;
  }
  // ---------------------------------------------------------------- history
  const list = project => Array.isArray(project?.releases) ? project.releases.filter(r => plain(r) && str(r.id) && str(r.name) && Array.isArray(r.packages)) : [];
  function add(project, record) {
    if (!plain(record) || !str(record.id) || !Array.isArray(record.packages)) fail("Not a release record.");
    if (!Array.isArray(project.releases)) project.releases = [];
    project.releases = project.releases.filter(r => r?.id !== record.id);
    project.releases.push(JSON.parse(JSON.stringify(record)));
    while (project.releases.length > MAX_RECORDS) project.releases.shift();
    return record;
  }
  function removeRecord(project, id) {
    const before = list(project).length;
    if (Array.isArray(project.releases)) project.releases = project.releases.filter(r => r?.id !== id);
    if (Array.isArray(project.releases) && !project.releases.length) delete project.releases;
    return before !== list(project).length;
  }

  // ---------------------------------------------------------------- compare
  // Paths inside a package lose the package folder, and names that carry the revision or date are
  // matched with those parts blanked, so "Sensor-B.GTL" and "Sensor-C.GTL" are the same file.
  function compare(a, b, opts = {}) {
    if (!plain(a) || !plain(b)) fail("Choose two releases to compare.");
    const pa = a.packages?.find(p => p.variant === opts.variant) || a.packages?.[0], pb = b.packages?.find(p => p.variant === (opts.variant ?? pa?.variant)) || b.packages?.[0];
    const norm = (rec, p) => {
      const word = x => new RegExp("(^|[^A-Za-z0-9])" + String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[^A-Za-z0-9]|$)", "g");
      const blank = s => [rec.revision, rec.date?.slice(0, 10), p?.variant].filter(x => x && String(x).length > 0)
        .reduce((t, x) => t.replace(word(x), "$1{}"), s);
      return new Map((p?.files || []).map(f => [blank(f.path), f]));
    };
    const fa = norm(a, pa), fb = norm(b, pb), files = {added: [], removed: [], changed: [], same: [], datesOnly: []};
    for (const [k, f] of fb) {
      const o = fa.get(k);
      if (!o) files.added.push({path: f.path, bytes: f.bytes});
      else if (o.sha256 === f.sha256) files.same.push(f.path);
      else if (o.stable && o.stable === f.stable) files.datesOnly.push(f.path);
      else files.changed.push({path: f.path, before: o.bytes, after: f.bytes});
    }
    for (const [k, f] of fa) if (!fb.has(k)) files.removed.push({path: f.path, bytes: f.bytes});
    // BOM by designator.
    const byRef = rows => { const m = new Map(); for (const r of rows || []) if (!r[4]) for (const ref of String(r[0]).split(",")) if (ref) m.set(ref, r); return m; };
    const ba = byRef(pa?.bom), bb = byRef(pb?.bom), bom = {added: [], removed: [], changed: [], available: !!(pa?.bom && pb?.bom)};
    for (const [ref, r] of bb) { const o = ba.get(ref); if (!o) bom.added.push({ref, comment: r[1], footprint: r[2], mpn: r[3]}); else { const f = ["comment", "footprint", "mpn"].filter((_, i) => o[i + 1] !== r[i + 1]); if (f.length) bom.changed.push({ref, fields: f, before: {comment: o[1], footprint: o[2], mpn: o[3]}, after: {comment: r[1], footprint: r[2], mpn: r[3]}}); } }
    for (const [ref, r] of ba) if (!bb.has(ref)) bom.removed.push({ref, comment: r[1], footprint: r[2], mpn: r[3]});
    const nat = (x, y) => String(x.ref ?? x.path).localeCompare(String(y.ref ?? y.path), undefined, {numeric: true});
    for (const l of [bom.added, bom.removed, bom.changed]) l.sort(nat);
    let design = null;
    const notes = [];
    if (a.designHash && a.designHash === b.designHash) notes.push("The design is identical (same design hash).");
    if (a.rulesHash !== b.rulesHash) notes.push("The design rules changed.");
    if (opts.before && opts.after && globalThis.AtriumDiff) {
      try { const d = AtriumDiff.compare(opts.before, opts.after); design = {summary: d.summary, changes: d.changes.slice(0, 200).map(c => ({severity: c.severity, category: c.category, text: c.text}))}; }
      catch (e) { notes.push("Design diff failed: " + e.message); }
    } else if (a.designHash !== b.designHash) notes.push(opts.before && opts.after ? "The design diff engine is not loaded." :
      "For a design diff, both designs are needed: a release made in this session, a Git commit, or the open design.");
    if (files.datesOnly.length) notes.push(files.datesOnly.length + " file" + (files.datesOnly.length === 1 ? " differs" : "s differ") + " only in dates, times or checksums.");
    return {a: {id: a.id, name: a.name}, b: {id: b.id, name: b.name}, files, bom, design, notes};
  }

  // ---------------------------------------------------------------- headless (MCP release / list_releases)
  // h: {project(), board(p, id), dateOf(text), text(data) -> {binary, body}, state}. release_run keeps
  // the files in h.state.release until release_done; the host writes them one at a time.
  const brief = r => ({id: r.id, name: r.name, date: r.date, revision: r.revision, job: r.job, ok: !!r.ok, package: r.package, git: r.git || null,
    overrides: r.overrides || [], gates: r.gates || [], packages: (r.packages || []).map(p => ({name: p.name, variant: p.variant, ok: p.ok, files: (p.files || []).length}))});
  function headless(op, a, h) {
    const p = h.project();
    const setOf = () => {
      let set = J().resolve(p, a.definition ?? a.job ?? fail("Name a job set (job) or pass a definition."), a);
      if (a.package) set = {...set, package: a.package === "vendor" ? {mode: "vendor", vendor: a.vendor || set.package?.vendor || "JLCPCB"} : {mode: a.package}, zip: a.package === "zip"};
      if (a.board != null) { h.board(p, a.board); set = {...set, board: a.board}; }
      return set;
    };
    const opts = () => ({date: h.dateOf(a.date), revision: a.revision, variants: a.variants, overrides: a.overrides || [], notes: a.notes,
      odbEnabled:a.odbEnabled===true,provenance:a.provenance,
      git: a.git || {available: false, reason: "No Git repository: the release records no commit."}, toolVersion: a.tool_version});
    if (op === "release_plan") {
      const set = setOf(), o = opts(), pf = preflight(p, set, o), named = variantList(p).length > 0, blocked = blocking(pf.checks, o.overrides);
      return {job: set.name, preset: !!set.preset, package: set.package, revision: revisionOf(p, set, o), date: o.date.toISOString(),
        packages: pf.targets.map(t => ({variant: named ? t.name : null, name: packageName(p, set, {...o, variant: named ? t.name : ""}) + (set.package.mode === "zip" ? ".zip" : "/")})),
        checks: pf.checks, blocking: blocked.map(c => c.id), ready: !blocked.length,
        outputs: set.outputs.map(x => ({id: x.id, kind: x.kind, group: J().groupOf(x.kind), label: x.label || J().KINDS[x.kind]?.label || x.kind, enabled: x.enabled}))};
    }
    if (op === "release_run") {
      const out = releaseSync(p, setOf(), opts());
      h.state.release = out;
      return {name: out.name, ok: out.ok, record: out.record, files: out.files.map(f => f.name),
        packages: out.packages.map(k => ({name: k.name, variant: k.variant, ok: k.ok, outputs: k.manifest.outputs, files: k.files}))};
    }
    if (op === "release_file") {
      const f = h.state.release?.files[a.index] || fail("Run the release first.");
      const t = h.text(f.data);
      return [{name: f.name, binary: t.binary}, t.body];
    }
    if (op === "release_done") { h.state.release = null; return {}; }
    if (op === "list_releases") return {releases: list(p).map(brief)};
    fail("Unknown release operation " + op + ".");
  }

  return Object.freeze({VERSION, WORKER_KINDS, WORKER_GLOBALS, canon, slices, designHash, rulesHash, stableHash, inputHash, createCache, targets, revisionOf, packageName,
    preflight, preflightAsync, blocking, generate, workerPool, release, releaseSync, headless, releaseMarkdown, list, add, remove: removeRecord, compare, bomSnapshot});
})();
