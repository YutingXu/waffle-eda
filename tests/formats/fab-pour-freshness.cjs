"use strict";
// Fabrication outputs never plot stale copper and never leave it out (fab-outputs.js analyse,
// polygon-pour.js outputCopper and settle, output-jobs.js settle):
//   - a rule edit makes a stored pour stale: headless outputs (build, Output Jobs, the MCP path) plot
//     the exact fill made on a copy, byte for byte Repour All's, and leave the design unchanged;
//   - in the editor, Output Jobs wait for the exact fill: Repour All runs (one undo step) with its
//     progress, then the files carry the committed copper;
//   - a cancel during the fill rejects with no file made and nothing committed;
//   - imported copper without an editable pour is plotted as stored, and the report says so.
// Node: node tests/formats/fab-pour-freshness.cjs   JSC: scripts/test-jsc.sh fab-pour-freshness
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "vectorize", "stackup", "net-intent", "signals", "rules", "viastack", "board-shape",
  "polygon-pour", "zip", "fab-outputs", "step-export", "output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, PP = AtriumPolygonPour, F = AtriumFabOutputs, J = AtriumOutputJobs;
const date = new Date(Date.UTC(2026, 10, 20, 12)), wait = ms => new Promise(r => setTimeout(r, ms));
const text = d => typeof d === "string" ? d : new TextDecoder().decode(d);
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
const pcb = p => p.documents.find(d => d.kind === "pcb");
// The project's clearance rule (the rule book, project-rules.js): every board inherits it.
const setClearance = (p, gap) => AtriumProjectRules.edit(p, b => { b.list.find(r => r.type === "clearance" && AtriumDesignQueryRecord.isAll(r.scope)).gap = gap; });

// A held pool: solves wait for release() (a cancel can land mid-fill), then answer.
let held = null;
const pool = {size: 2, available: true, jobs: 0, run(task) {
  this.jobs++;
  return this.reply = new Promise((ok, no) => {
    const go = () => setTimeout(() => { try { ok(PP._internal.core.solve(task)); } catch (e) { no(e); } }, 0);
    if (held) held.then(go); else go();
  });
}, stats: () => ({workerMs: 0})};
globalThis.AtriumWorkerPool = {get: () => pool, find: () => pool};

function project() {
  const p = A.project("Fresh"), d = pcb(p);
  d.name = "Fresh"; d.outline = [[0, 0], [50, 0], [50, 40], [0, 40]];
  d.items = [PP.make([[1, 1], [30, 1], [30, 30], [1, 30]], {id: "gnd", net: "GND", layer: "Top", removeDeadCopper: false}),
    {id: "v", kind: "via", layer: "Multi", net: "B", x: 7, y: 7, diameter: .8, drill: .3},
    {id: "t", kind: "track", layer: "Top", net: "B", width: .25, points: [[7, 7], [20, 12]]}];
  setClearance(p, .2);
  PP.apply(d, defsOf(p), {project: p});
  assert.deepEqual(PP.stale(d, defsOf(p), {project: p}), []);
  return p;
}
const gerberSet = {name: "Gerber", outputs: [{id: "g", kind: "gerber", enabled: true, options: {readme: true}}]};
const top = files => text(files.find(f => /\.GTL$/.test(f.name)).data ?? files.find(f => /\.GTL$/.test(f.name)).content);
const readmeOf = files => text((files.find(f => /Readme\.txt$/.test(f.name)) || {}).data ?? files.find(f => /Readme\.txt$/.test(f.name)).content);
const regionsIn = g => (g.match(/G36\*/g) || []).length;
// Repour All's copper for the project as it stands, on a copy.
function reference(p) {
  const q = A.clone(p);
  PP.apply(pcb(q), defsOf(q), {project: q, reuse: false});
  return {q, gtl: top(F.build(q, pcb(q), {date}).files)};
}

let interruptExport;
const restoreWorker = require("../support/import-worker.cjs")({
  client: true,
  configureWorker(worker) {
    // The two realms share wall time, including the fixed clock in the ZIP comparison.
    Object.defineProperty(worker, "Date", {get: () => Date});
    const send = worker.postMessage;
    worker.postMessage = message => {
      if (message.type === "result") interruptExport?.();
      send(message);
    };
  }
});
// Capture the static test transport before the STEP dependencies load the browser registry.
const transportLoader = globalThis.AtriumLazy;
require("../support/3d-geometry.cjs");
const {files, needsRuleQuery} = globalThis.AtriumLazy;
globalThis.AtriumLazy = {...transportLoader, files, needsRuleQuery};
globalThis.__testDone = (async () => {
  // ---- Headless: a rule edit makes the pour stale; the outputs carry the exact fill.
  {
    const p = project(), before = top(F.build(p, pcb(p), {date}).files);
    assert.ok(regionsIn(before) > 0);
    setClearance(p, 1.4);
    assert.equal(F.pourStatus(pcb(p), defsOf(p), p), "stale", "the inherited rule edit is seen");
    const saved = JSON.stringify(pcb(p)), ref = reference(p), out = F.build(p, pcb(p), {date});
    assert.equal(top(out.files), ref.gtl, "the stale pour is plotted as Repour All fills it");
    assert.notEqual(ref.gtl, before, "the new clearance changes the copper");
    assert.ok(regionsIn(ref.gtl) > 0, "copper is plotted, not left out");
    assert.equal(JSON.stringify(pcb(p)), saved, "making outputs leaves the design unchanged");
    assert.ok(out.warnings.some(w => /filled again for these outputs: GND on Top/.test(w)), out.warnings.join("\n"));
    assert.match(readmeOf(out.files), /Copper pours: exact fill made for these outputs \(\d+ regions?\); 1 pour was out of date or not yet poured in the design file\./);
    // Output Jobs (synchronous, MCP) and the asynchronous runner away from the editor: the same copper.
    const job = J.run(p, gerberSet, {date});
    assert.equal(top(job.files), ref.gtl, "Output Jobs run()");
    assert.ok(job.report.warnings.some(w => /filled again/.test(w)));
    const progress = [], ajob = await J.runAsync(p, gerberSet, {date}, e => progress.push(e));
    assert.equal(top(ajob.files), ref.gtl, "Output Jobs runAsync()");
    // The dialog's deferred analysis names the pending pour instead of solving it.
    const deferred = F.analyse(p, pcb(p), {pourFill: "defer"});
    assert.equal(deferred.pours, "pending");
    assert.deepEqual(deferred.copper.pending, ["gnd"]);
    assert.ok(!deferred.layers.get("Top").some(f => f.t === "pour"), "no copper is solved or plotted while pending");
    const step=(plan, pourFill)=>AtriumSTEP.model(plan,pcb(plan),{copper:true,components:false,fab:{pourFill}});
    const layers=(plan, pourFill)=>step(plan,pourFill).layers;
    const exact=step(p), stored=layers(p,"stored"), pending=layers(p,"defer");
    assert.deepEqual(exact.layers,layers(ref.q,"stored"),"direct STEP refills the same area as Repour All");
    assert.notDeepEqual(stored,exact.layers,"explicit stored mode keeps the earlier copper");
    assert.ok(pending.find(l=>l.key==="Top").prisms.length<stored.find(l=>l.key==="Top").prisms.length,
      "deferred mode leaves the stale pour out while retaining authored items");
    assert.ok(exact.notes.some(n=>n.includes("filled again for this export")));
    assert.equal(JSON.stringify(pcb(p)),saved,"direct STEP never adopts or fills the design document");
    // A current board: the stored fill, said so, with no warning.
    const fresh = ref.q, current = F.build(fresh, pcb(fresh), {date});
    assert.equal(top(current.files), ref.gtl);
    assert.ok(!current.warnings.some(w => /filled again|imported copper/i.test(w)), current.warnings.join("\n"));
    assert.match(readmeOf(current.files), /Copper pours: the exact fill stored in the design \(\d+ regions?\), current with the board\./);
    console.log("ok - a stale pour after a rule edit: outputs carry Repour All's copper; the design is unchanged");
  }

  // ---- Editor: Output Jobs wait for the exact fill, which Repour All commits with its progress.
  const editor = p => {
    let revision = 0;
    const H = {project: () => p, doc: () => pcb(p), defs: () => defsOf(p), revision: () => revision, info() {}, registerAction() {}, invalidate() {}, redraw() {},
      on() { return () => {}; }, selection: () => [], drag: () => null, edits: 0,
      edit(fn) { fn(); revision++; H.edits++; }, derive(fn) { fn(); revision++; }};
    return H;
  };
  {
    const p = project(), H = editor(p);
    PP.live.reset(); PP.live.setMode("manual"); PP.speculation?.setMode?.("off"); PP.live.attach(H);
    setClearance(p, 1.4);
    const ref = reference(p), progress = [];
    const res = await J.runAsync(p, gerberSet, {date}, e => progress.push(e));
    assert.equal(H.edits, 1, "Repour All committed once (one undo step)");
    assert.deepEqual(PP.stale(pcb(p), defsOf(p), {project: p}), [], "the design now holds the exact fill");
    assert.equal(top(res.files), ref.gtl, "the files carry the committed copper");
    assert.ok(!res.report.warnings.some(w => /filled again/.test(w)), "nothing left to fill on a copy");
    const fill = progress.filter(e => e.phase === "pours");
    assert.ok(fill.length >= 2 && fill.at(-1).done === fill.at(-1).total, "the fill reports progress: " + JSON.stringify(fill));
    assert.ok(progress.findIndex(e => e.phase === "pours") < progress.findIndex(e => e.phase === "start"), "outputs start after the fill");
    // Already current: no second Repour All.
    await J.runAsync(p, gerberSet, {date});
    assert.equal(H.edits, 1);
    console.log("ok - editor Output Jobs wait for Repour All, then plot the committed copper");

    // ---- A cancel during the fill: no file, nothing committed, the pour stays stale.
    setClearance(p, .6);
    const stored = JSON.stringify(pcb(p).pcbDrawing);
    let release;
    held = new Promise(r => { release = r; });
    const ac = new AbortController(), events = [];
    const jobs = pool.jobs, run = J.runAsync(p, gerberSet, {date, signal: ac.signal}, e => events.push(e));
    for (let i = 0; i < 400 && pool.jobs === jobs; i++) await wait(1);
    assert.ok(pool.jobs > jobs && events.some(e => e.phase === "pours"), "the held worker started filling");
    ac.abort();
    release(); held = null;
    await assert.rejects(run, e => e.name === "AbortError", "the run rejects as cancelled");
    assert.ok(!events.some(e => e.phase === "start" || e.phase === "done"), "no output step ran");
    await pool.reply;
    assert.equal(H.edits, 1, "nothing committed");
    assert.equal(JSON.stringify(pcb(p).pcbDrawing), stored, "the stored copper is unchanged");
    assert.deepEqual(PP.stale(pcb(p), defsOf(p), {project: p}), ["gnd"], "the pour is still out of date");
    // The next run fills it.
    const again = await J.runAsync(p, gerberSet, {date});
    assert.equal(H.edits, 2);
    assert.equal(top(again.files), reference(p).gtl);
    console.log("ok - a cancel mid-fill writes nothing and commits nothing");
    PP.live.reset();
  }

  // ---- The Fabrication Outputs dialog (a minimal DOM): opened on stale pours, it fills them and its
  // analysis refreshes by itself; a download waits for the fill; closing it mid-fill saves nothing.
  {
    require("../../app/editor/nav-common.js");
    class Node {
      constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.hidden = false;
        this.textContent = ""; this.className = ""; this.value = ""; this.parent = null;
        this.listeners = new Map();
        this.classList = {
          contains: name => this.className.split(/\s+/).includes(name),
          add: name => { if (!this.classList.contains(name)) this.className = (this.className + " " + name).trim(); }
        };
      }
      matches(selectors) {
        return selectors.split(",").some(selector => {
          const s = selector.trim();
          if (/^\.[\w-]+$/.test(s)) return this.classList.contains(s.slice(1));
          if (s === "[data-variant=danger][data-ui-default]:not([data-ui-default=false])") {
            return this.dataset.variant === "danger" && "uiDefault" in this.dataset && this.dataset.uiDefault !== "false";
          }
          throw Error("Unsupported fabrication-dialog test selector: " + s);
        });
      }
      append(...list) { for (const c of list) { const n = typeof c === "string" ? Object.assign(new Node("#text"), {textContent: c}) : c; n.parent?.removeChild?.(n); n.parent = this; this.children.push(n); } }
      prepend(...list) { this.append(...list); this.children.unshift(...this.children.splice(-list.length)); }
      removeChild(n) { this.children = this.children.filter(x => x !== n); n.parent = null; }
      replaceChildren(...list) { for (const c of this.children) c.parent = null; this.children = []; this.append(...list); }
      remove() { this.parent?.removeChild(this); }
      setAttribute(k, v) { this.attrs[k] = String(v); }
      getAttribute(k) { return this.attrs[k] ?? null; }
      hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
      get type() { return this.getAttribute("type") || (this.tagName === "BUTTON" ? "submit" : "text"); }
      set type(value) { this.setAttribute("type", value); }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      get childElementCount() { return this.children.length; }
      add(o) { this.children.push(o); if (this.children.length === 1) this.value = o.value; }
      showModal() { this.open = true; }
      close() { if (!this.open) return; this.open = false; this.onclose?.(); }
      text() { return this.textContent + this.children.map(c => typeof c.text === "function" ? c.text() : "").join(" "); }
      find(f) { if (f(this)) return this; for (const c of this.children) { const r = c.find?.(f); if (r) return r; } return null; }
    }
    globalThis.document = {createElement: tag => new Node(tag), body: new Node("body")};
    globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
    require("../../app/ui/dialog.js");
    globalThis.AtriumShell = {adoptDialog: AtriumUI.adoptDialog};
    const p = project(), H = editor(p);
    PP.live.reset(); PP.live.setMode("manual"); PP.live.attach(H);
    setClearance(p, 1.4);
    const ref = reference(p), saved = [];
    const ctx = {project: p, doc: pcb(p), revision: H.revision, currentProject: H.project, info() {}, exportFile: async (name, data) => { saved.push({name, data}); return true; }};
    const latin1 = b => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
    const open = () => { F.open(ctx); return document.body.children.at(-1); };
    const status = d => d.find(n => n.className === "fab-status").textContent;
    const summary = d => d.find(n => n.tagName === "P" && n.className === "").textContent;
    const downloadAll = d => d.find(n => n.tagName === "BUTTON" && n.textContent === "Download all (.zip)");
    let d = open();
    assert.ok(d.find(n => n.classList?.contains("ui-dialog-title")), "the fabrication dialog uses the shared title");
    assert.equal(downloadAll(d).dataset.variant, "primary");
    assert.equal(d.find(n => n.textContent === "Close").dataset.variant, "secondary");
    assert.match(summary(d), /copper pours filling/, "opened on stale pours: " + summary(d));
    assert.match(status(d), /Filling copper pours/);
    for (let i = 0; i < 2000 && (H.edits < 1 || /Filling/.test(status(d))); i++) await wait(1);
    assert.equal(H.edits, 1, "the dialog's fill is Repour All (one undo step)");
    assert.match(summary(d), /\d+ pour regions/, "the analysis refreshed by itself: " + summary(d));
    assert.ok(d.text().includes("Copper pours: the exact fill stored in the design"), "the Gerber tab says which copper is plotted");
    await downloadAll(d).onclick();
    assert.equal(saved.length, 1, status(d));
    assert.ok(latin1(saved[0].data).includes(ref.gtl.slice(ref.gtl.indexOf("G36*"), ref.gtl.lastIndexOf("G37*"))), "the zip carries the exact copper");
    assert.equal(d.open, false, "the dialog closed after saving");

    // Stale again, solves held: Download all waits; closing the dialog cancels it and saves nothing.
    setClearance(p, .6);
    const stored = JSON.stringify(pcb(p).pcbDrawing);
    let release;
    held = new Promise(r => { release = r; });
    d = open();
    const pending = downloadAll(d).onclick();
    for (let i = 0; i < 400 && !/Filling copper pours: 0 of/.test(status(d)); i++) await wait(1);
    d.close();
    release(); held = null;
    await pending;
    await wait(30);
    assert.equal(saved.length, 1, "nothing saved after the cancel");
    assert.equal(H.edits, 1, "nothing committed");
    assert.equal(JSON.stringify(pcb(p).pcbDrawing), stored);
    console.log("ok - the dialog fills stale pours, refreshes its analysis by itself, and a close mid-fill saves nothing");
    PP.live.reset();
    // One unchanged panel analysis; an edit before Download gets fresh manufacturing data.
    // Freeze time so every record including the Gerber date and DOS ZIP stamps is comparable.
    const fresh = project(), host = editor(fresh), emitted = [];
    const RealDate = Date;
    let analyses = 0;
    try {
      globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [date.getTime()])); } };
      globalThis.AtriumPolygonPour = {...PP, outputCopper(...args) { analyses++; return PP.outputCopper(...args); }};
      const begin = () => {
        F.open({project: fresh, doc: pcb(fresh), revision: host.revision, currentProject: host.project,
          exportFile: async (name, bytes) => { emitted.push({name, bytes}); return true; }});
        return document.body.children.at(-1);
      };
      const expected = () => F.build(fresh, pcb(fresh), {fileStem: F.defaultStem(fresh, pcb(fresh))});
      let expectedResult = expected(), panel = begin(), before = analyses;
      await downloadAll(panel).onclick();
      assert.equal(analyses, before, "Download reuses the panel's settled board analysis");
      assert.equal(emitted[0].name, expectedResult.name);
      assert.deepEqual([...emitted[0].bytes], [...F.zip(expectedResult)], "same filenames, contents, settings, order and ZIP bytes");
      panel = begin(); host.edit(() => { pcb(fresh).origin = [8, 9]; }); before = analyses;
      await downloadAll(panel).onclick();
      assert.equal(analyses, before + 1, "a board edit after opening refreshes exactly once");
      expectedResult = expected();
      assert.deepEqual([...emitted[1].bytes], [...F.zip(expectedResult)]);
      for (const stop of [p => p.close(), () => host.edit(() => { setClearance(fresh, .8); })]) {
        panel = begin();
        let interrupted = false;
        interruptExport = () => { interrupted = true; stop(panel); };
        try { await downloadAll(panel).onclick(); }
        finally { interruptExport = null; }
        assert.ok(interrupted, "the worker generated the export before the dialog was closed or edited");
        assert.equal(emitted.length, 2, "a close or rule edit during an export cannot publish an outdated ZIP");
        if (panel.open) { assert.match(status(panel), /changed/); panel.close(); }
      }
    } finally {
      globalThis.Date = RealDate; globalThis.AtriumPolygonPour = PP;
    }
    delete globalThis.document; delete globalThis.Option; delete globalThis.AtriumShell; delete globalThis.AtriumUI;
  }

  // ---- Imported copper without an editable pour: plotted as stored, with a note.
  {
    const p = project(), d = pcb(p), defs = defsOf(p), poured = regionsIn(top(F.build(p, d, {date}).files));
    // Turn the poured copper into imported artwork: regions with no polygon, stamped with the board.
    const regions = d.pcbDrawing.pours.map(r => ({...r, polygon: undefined}));
    for (const r of regions) delete r.polygon;
    d.items = d.items.filter(i => i.kind !== "polygon");
    d.pcbDrawing = {annotations: {}, pours: regions};
    d.sourcePourSignature = AtriumPCBPours.signature(d, defs, p);
    const stored = top(F.build(p, d, {date}).files);
    assert.equal(regionsIn(stored), poured);
    assert.match(readmeOf(F.build(p, d, {date}).files), /Imported copper: \d+ regions? without an editable pour, plotted as stored in the imported design \(the board is unchanged since import\)\./);
    // A later board edit cannot be filled into noneditable artwork: honoured as stored, with a warning.
    d.items.find(i => i.id === "t").points[1] = [24, 14];
    const out = F.build(p, d, {date}), gtl = top(out.files);
    assert.equal(regionsIn(gtl), poured, "the imported regions are still plotted");
    assert.ok(out.warnings.some(w => /imported copper regions? without an editable pour (is|are) plotted as stored.*changed since import/.test(w)), out.warnings.join("\n"));
    assert.match(readmeOf(out.files), /\(the board has changed since import\)/);
    const job = J.run(p, gerberSet, {date});
    assert.equal(regionsIn(top(job.files)), poured);
    assert.ok(job.report.warnings.some(w => /changed since import/.test(w)), "the job report carries the note");
    console.log("ok - imported stored fill is honoured with a note");
  }
})().finally(restoreWorker).catch(e => { console.error(e); process.exitCode = 1; throw e; });
if (typeof process.once === "function") {
  let completed = false;
  globalThis.__testDone.then(() => { completed = true; }, () => { completed = true; });
  process.once("beforeExit", () => assert.ok(completed, "Fabrication scenarios did not finish."));
}
