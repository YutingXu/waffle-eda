"use strict";
// Drive the same File input, document tabs, registered editor actions, modal controls and undo stack as the desktop.
// Only picker input and the export destination are in memory. No design is handed to the OS save panel.
globalThis.__uiProbes = {async run(only, input) {
  const h = AtriumNavHost, trace = globalThis.tourTrace;
  const native = (op, fields = {}) => webkit.messageHandlers.harness.postMessage({op, ...fields});
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const paint = async () => { await frame(); await frame(); };
  const $ = selector => document.querySelector(selector);
  const button = (node, name) => [...node.querySelectorAll("button")].find(b => b.textContent.trim() === name);
  const status = () => $("#status")?.textContent || "";
  const report = {design: input.name, theme: input.theme, sheets: 0, boards: 0, documents: [], comparisons: [],
    output: [], drc: [], erc: null, edits: 0, undos: 0, redos: 0, issueStrings: [], assertions: [], passed: false};
  const record = () => native("save", {name: "tour.json", text: JSON.stringify(report, null, 2)});
  const failure = message => Object.assign(new Error(message), {tourAssertion: true});
  const check = (value, name) => { if (!value) throw failure(name); report.assertions.push(name); };
  const wait = async (predicate, description, timeout = 90000) => {
    const end = performance.now() + timeout;
    for (;;) {
      const value = predicate(); if (value) return value;
      if (performance.now() >= end) throw failure(description);
      await sleep(50);
    }
  };
  function saveWarnings(phase) {
    const messages = globalThis.AtriumMessages?.messages() || [];
    const warnings = messages.filter(m => ["Fatal", "Error", "Warning"].includes(m.class)).map(m => input.private ? {class: m.class} : {class: m.class, group: m.group, text: m.text});
    (report.messages ||= {})[phase] = warnings;
  }
  let action = "setup";
  function mark(name) { action = name; trace.mark(name); void native("save", {name: "phase.txt", text: name}); }
  function inspectText() {
    // Only visible interface controls; component values and free-form design text are not audited as UI copy.
    const candidates = document.querySelectorAll('button, [role="tab"], [role="status"], dialog[open] h2, .fab-warnings li');
    for (const element of candidates) {
      if (!element.getClientRects().length) continue;
      const value = (element.innerText || "").trim();
      const token = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{[^}]+\}\}/.exec(value);
      if (!token) continue;
      const type = token[0].startsWith("{{") ? "unresolved-placeholder" : token[0];
      if (!report.issueStrings.some(x => x.action === action && x.type === type)) report.issueStrings.push({action, type, ...(input.private ? {} : {value})});
    }
  }
  function files(series) {
    return series.map(({name, blob}) => {
      const binary = atob(input.blobs[blob]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name);
    });
  }
  function deliver(list) {
    const transfer = new DataTransfer(); for (const file of list) transfer.items.add(file);
    const target = $("#file-input"); target.files = transfer.files; target.dispatchEvent(new Event("change", {bubbles: true}));
  }
  function sourceDocuments(series) {
    return series.filter(x => /\.(schdoc|pcbdoc|kicad_pcb|kicad_sch)$/i.test(x.name));
  }
  function ensureSource(project, series, provenance) {
    const expected = sourceDocuments(series).map(f => f.name).sort();
    const sources = new Map(provenance.flatMap(group => group.files.flatMap(f => f.documents.map(id => [id, f.name]))));
    const docs = project.documents.filter(d => sources.has(d.id));
    const actual = docs.map(d => sources.get(d.id)).sort();
    check(JSON.stringify(actual) === JSON.stringify(expected), "Every selected source document opened");
    check(docs.every(d => d.items.length > 0), "Every source view contains imported objects");
  }
  async function importBaseline(series) {
    // Same reader, validation, source reconciliation and background pour adoption as File > Open, without replacing the editor window.
    const read = AtriumDesignReader, work = read.progress();
    try {
      const selected = await read.read(files(series), work, () => {});
      const {after} = await read.assemble(selected, h.project(), h.currentId());
      await read.prepare(after, selected.files, work, () => {});
      ensureSource(after, series, [selected.provenance]);
      return after;
    } finally { work.close(); }
  }
  function selectDoc(d) {
    const tab = [...document.querySelectorAll("#document-tabs [data-tab]")].find(t => t.dataset.tab === d.id);
    if (tab) tab.click(); else h.selectDocument(d.id);
    check(h.currentId() === d.id, "Activated the intended editor document");
  }
  async function compare(name, baseline, same, control = false) {
    const oldPicker = AtriumIO.pickFile;
    // The desktop revision panel accepts one Waffle project. Keep the selected object and its filename in this web view.
    AtriumIO.pickFile = async () => new File([JSON.stringify(baseline)], "Previous.waffle", {type: "application/json"});
    try {
      h.act("compare");
      const dialog = await wait(() => $('dialog[aria-label="Change table"][open]'), "Change table failed to open");
      button(dialog, "Choose revision…").click();
      const rows = await wait(() => {
        const text = dialog.querySelector('[role="status"]').textContent;
        if (/Working design · No differences$/.test(text)) return {count: 0};
        const match = /Working design · \d+–\d+ of (\d+) changes?/.exec(text);
        return match && {count: +match[1]};
      }, "No comparison result", 180000);
      const severity = Object.fromEntries([...dialog.querySelectorAll("[data-severity]")].map(e => [e.dataset.severity, parseInt(e.textContent, 10)]));
      const result = {kind: name, sameSources: same, rows: rows.count, severity};
      if (same && rows.count && !input.private) {
        result.examples = [];
        for (const option of [...dialog.querySelectorAll(".rev-option")].slice(0, 6)) {
          option.click();
          result.examples.push({title: option.innerText, fields: [...dialog.querySelectorAll(".rev-values tbody tr")].slice(0, 6).map(tr => tr.innerText.slice(0, 250))});
        }
      }
      report.comparisons.push(result); inspectText();
      if (control) check(rows.count === 0, "An identical working-design snapshot gives no differences");
      if (same && !control && rows.count) (report.findings ||= []).push("Independent imports of identical sources differed in Compare");
      button(dialog, "Done").click(); await paint();
    } finally { AtriumIO.pickFile = oldPicker; }
  }
  const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
  });
  function memberCRC(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zipContents(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
    check(end >= 0 && v.getUint32(end, true) === 0x06054b50, "Fabrication ZIP has a complete central directory");
    let pos = 0, copper = 0, drill = 0; const entries = [], decoder = new TextDecoder();
    while (pos < end && v.getUint32(pos, true) === 0x04034b50) {
      const offset = pos, length = v.getUint32(offset + 18, true), nameSize = v.getUint16(offset + 26, true);
      const start = offset + 30, name = decoder.decode(bytes.subarray(start, start + nameSize));
      const begin = start + nameSize + v.getUint16(offset + 28, true); pos = begin + length;
      if (pos > end || v.getUint16(offset + 8, true) !== 0 || v.getUint32(offset + 22, true) !== length) throw Error("Malformed stored ZIP member");
      const data = bytes.subarray(begin, pos), crc = memberCRC(data);
      if (crc !== v.getUint32(offset + 14, true)) throw Error("Fabrication member CRC mismatch");
      const prefix = decoder.decode(data.subarray(0, 200));
      if (/\.(gtl|gbl)$/i.test(name) && /^G04|%FSL/.test(prefix)) copper++;
      if (/^M48/m.test(prefix)) drill++;
      entries.push({name, crc, length, offset});
    }
    check(pos === v.getUint32(end + 16, true) && end - pos === v.getUint32(end + 12, true) && entries.length === v.getUint16(end + 10, true),
      "ZIP member count, central directory size and offset agree");
    for (const entry of entries) {
      const size = v.getUint16(pos + 28, true), name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + size));
      if (v.getUint32(pos, true) !== 0x02014b50 || entry.name !== name || entry.crc !== v.getUint32(pos + 16, true) ||
          entry.length !== v.getUint32(pos + 24, true) || entry.offset !== v.getUint32(pos + 42, true)) throw Error("Fabrication ZIP directory entry mismatch");
      pos += 46 + size + v.getUint16(pos + 30, true) + v.getUint16(pos + 32, true);
    }
    check(pos === end && copper > 0, "ZIP contains readable copper outputs");
    return {files: entries.length, names: entries.map(e => e.name), copper, drill, bytes: bytes.length};
  }
  async function outputs() {
    let captured, dialog;
    const writer = AtriumIO.exportFile;
    AtriumIO.exportFile = async (_name, bytes) => {
      const {names, ...summary} = trace.timed("test-zip-crc", () => zipContents(bytes));
      const planned = [...dialog.querySelectorAll(".fab-files .review-line strong")].map(n => n.textContent);
      check(sameDesign(planned, names), "ZIP members match every planned filename and order");
      const warnings = [...dialog.querySelectorAll(".fab-warnings li")].map(li => li.textContent);
      report.fabricationWarnings = input.private ? warnings.length : warnings;
      captured = summary; return true;
    };
    try {
      h.act("fab-outputs");
      dialog = await wait(() => $('dialog[aria-label="Fabrication outputs"][open]'), "Fabrication dialog failed to open");
      button(dialog, "Files").click();
      await wait(() => dialog.querySelectorAll(".fab-files .review-line").length, "Fabrication plan is empty");
      inspectText(); mark("fabrication-generate"); button(dialog, "Download all (.zip)").click();
      await wait(() => captured || (!dialog.querySelector(".work-actions button:last-child")?.disabled && dialog.querySelector(".fab-status")?.textContent && (() => {throw Error("Fabrication generation failed");})()), "No ZIP returned from Generate", 180000);
      report.output.push(captured); await paint();
    } finally { AtriumIO.exportFile = writer; }
  }
  function sameDesign(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a); if (keys.length !== Object.keys(b).length) return false;
    return keys.every(k => Object.hasOwn(b, k) && sameDesign(a[k], b[k]));
  }
  function differences(expected, actual) {
    const result = [];
    function inspect(a, b, path) {
      if (result.length >= 12 || a === b) return;
      if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) {
        result.push({path, a: typeof a, b: typeof b, ...(typeof a === "number" && typeof b === "number" ? {from: a, to: b} : {})}); return;
      }
      if (Array.isArray(a) && a.length !== b.length) result.push({path, before: a.length, after: b.length});
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) inspect(a[k], b[k], path + "/" + k);
    }
    inspect(expected, actual, ""); return result;
  }
  const snapshot = () => trace.timed("test-snapshot", () => JSON.parse(JSON.stringify(h.project())));
  // The first PCB inspection derives pad/copper links and signs a stored fill. Keep the actual
  // source regions, items, geometry, library and every other persisted field in the comparison.
  function authored(p) {
    return {...p, documents: p.documents.map(d => {
      if (!d.pcbDrawing) return d;
      const {sourcePourSignature, ...doc} = d;
      const drawing = {...d.pcbDrawing};
      for (const key of ["sourceFill", "pourSignatures", "pourSignatureVersion"]) delete drawing[key];
      if (drawing.pours) drawing.pours = drawing.pours.map(({links, ...r}) => r);
      return {...doc, pcbDrawing: drawing};
    })};
  }
  function boardCounts(p) {
    return p.documents.filter(d => d.kind === "pcb").map(d => ({
      objects: d.items.length, sourceHatchObjects: d.items.filter(i => i.sourcePour != null).length,
      polygons: d.items.filter(i => i.kind === "polygon").length, regions: d.pcbDrawing?.pours?.length || 0
    }));
  }
  function observeCopper(phase) {
    const counts = boardCounts(h.project()), changes = report.copperTransitions ||= [];
    if (!changes.length || !sameDesign(changes.at(-1).counts, counts)) changes.push({phase, counts});
  }
  function verifyDesign(expected, name) {
    const actual = h.project(), equal = trace.timed("test-equality", () => sameDesign(expected, actual));
    if (!equal && !input.private) report.differences = differences(expected, actual);
    check(equal, name);
  }
  try {
    check(!!trace && !!input && !!globalThis.AtriumHost, "Shipping desktop bridge and document-start observations are present");
    mark("prepare");
    const home = await wait(() => $("dialog.sp-dialog[open]"), "Start page did not open");
    home.querySelector("[data-start-action=close]").click(); await paint();
    check(!home.open, "Continued from Home to the visible editor");
    mark("theme-" + input.theme);
    AtriumTheme.set({preset: input.theme, followSystem: false}, {persist: false});
    await wait(() => document.documentElement.dataset.theme === input.theme && !document.documentElement.hasAttribute("data-theme-fading"), "Theme transition did not finish");
    await paint();
    if (input.original.length) {
      mark("open-original-legacy"); deliver(files(input.original));
      const dialog = await wait(() => [...document.querySelectorAll("dialog[open]")].find(d => d.textContent.includes("Legacy KiCad 4/5 files are not supported")), "Missing original legacy import explanation");
      check(h.isStarter(), "Original legacy import refused atomically");
      report.legacyRefused = true; button(dialog, "Done").click(); await paint();
    }
    mark("open"); const old = h.project(); deliver(files(input.current));
    await wait(() => h.project() !== old && !h.isStarter() && !$(".import-cancel"), "The editor did not adopt the selected design", 180000);
    ensureSource(h.project(), input.current, AtriumImportReports.provenance()); await paint();
    const source = h.project().documents.filter(d => AtriumImportReports.recent(d.id));
    const notes = AtriumImportReports.recent(source[0]?.id)?.report.notes || []; report.importNotes = notes.length;
    report.missingLibraries = input.missingLibraries;
    const adoptedWhenOpened = source.filter(d => d.kind === "pcb" && d.pcbDrawing?.sourceFill).length;
    saveWarnings("import");
    if (!input.private) report.importNotesText = notes;
    for (const [index, d] of source.entries()) {
      const kind = d.kind === "pcb" ? "board" : "sheet", number = index + 1;
      mark(kind + "-" + number); selectDoc(d); h.act("fit"); await paint(); inspectText();
      report.documents.push({kind, objects: d.items.length}); if (kind === "board") report.boards++; else report.sheets++;
      if (input.capture && (kind === "board" || report.sheets === 1)) {
        mark("capture-" + kind); await native("shot", {name: input.name + "-" + kind + "-" + input.theme}); await paint();
      }
    }
    const beforeChecks = snapshot(), outputEdits = []; observeCopper("document-visits");
    for (const prior of input.previous) {
      mark("read-" + prior.kind);
      const before = await importBaseline(prior.files);
      // Match the working window's initial board inspection before presenting the independent revision to Compare.
      const defs = new Map(before.library.map(def => [def.id, def]));
      for (const d of before.documents.filter(d => d.kind === "pcb" && d.pcbDrawing?.sourceFill)) globalThis.AtriumPolygonPour?.adopt(d, defs, {project: before}, false);
      mark("compare-" + prior.kind); await compare(prior.kind, before, prior.sameSources);
    }
    mark("compare-identical-control"); await compare("identical-control", snapshot(), true, true);
    observeCopper("compare"); const sheet = source.find(d => d.kind === "schematic");
    if (sheet) {
      mark("ERC"); selectDoc(sheet); h.act("compile");
      await wait(() => globalThis.AtriumMessages?.isOpen() && AtriumMessages.messages().some(m => m.group === "Compiler" && m.check === "summary"), "ERC results absent");
      const list = AtriumMessages.messages().filter(m => m.group === "Compiler" && m.check !== "summary");
      report.erc = {messages: list.length, warnings: list.filter(m => m.class === "Warning").length, errors: list.filter(m => m.class === "Error" || m.class === "Fatal").length};
      saveWarnings("ERC"); inspectText(); AtriumMessages.close(); await paint(); observeCopper("ERC");
    }
    for (const d of source.filter(d => d.kind === "pcb")) {
      mark("DRC"); selectDoc(d); h.act("drc");
      await wait(() => globalThis.AtriumMessages?.isOpen() && AtriumMessages.messages().some(m => m.group === "DRC") && /rule violation/.test(status()), "DRC results absent");
      const match = /(no|\d+) rule violations?/.exec(status()); check(!!match, "DRC completed on this board");
      report.drc.push(match[1] === "no" ? 0 : +match[1]); saveWarnings("DRC"); inspectText(); AtriumMessages.close(); await paint(); observeCopper("DRC");
      mark("Insights"); h.act("insights-panel");
      await wait(() => globalThis.AtriumMessages?.isOpen() && AtriumMessages.messages().some(m => m.group === "Insights") && globalThis.AtriumInsightsUI?.engine()?.state(d.id), "Insights returned no completed pass");
      report.insights = globalThis.AtriumInsightsUI.current().length; saveWarnings("Insights"); inspectText(); AtriumMessages.close(); await paint(); observeCopper("Insights");
      mark("fabrication"); const beforeOutput = snapshot(); await outputs(); observeCopper("fabrication");
      // The visible Fabrication dialog may explicitly run the editor's Repour All before plotting
      // previously unfilled zones. Keep the entire project on both sides of that session edit.
      if (!trace.timed("test-source-equality", () => sameDesign(authored(beforeOutput), authored(h.project())))) {
        outputEdits.push({before: beforeOutput, after: snapshot()});
      }
    }
    // Initial inspection resolves the imported copper-to-pad links. Snapshot the entire materialized design.
    report.pendingImportedFills = {opened: adoptedWhenOpened, afterInspection: source.filter(d => d.pcbDrawing?.sourceFill).length};
    const baseline = snapshot();
    report.inspectionChanged = !trace.timed("test-equality", () => sameDesign(beforeChecks, baseline));
    report.authoredDataIntact = !report.inspectionChanged || trace.timed("test-source-equality", () => sameDesign(authored(beforeChecks), authored(baseline)));
    if (report.inspectionChanged) report.boardCounts = {before: boardCounts(beforeChecks), after: boardCounts(baseline)};
    if (report.inspectionChanged && !input.private) report.inspectionDifferences = differences(beforeChecks, baseline);
    for (const kind of ["schematic", "pcb"]) {
      const id = source.find(d => d.kind === kind && d.items.some(i => i.kind === "part" && !i.locked && Number.isFinite(i.x)))?.id; if (!id) continue;
      mark("edit-" + kind); const d = h.docById(id); selectDoc(d);
      verifyDesign(baseline, "Selecting the edit document preserved the materialized design");
      const target = d.items.find(i => i.kind === "part" && !i.locked && Number.isFinite(i.x));
      check(!!target, "An editable component is present"); h.select([target.id]); const oldX = target.x;
      h.canvas().focus(); await native("key", {key: "ArrowRight", mods: ["cmd"]}); check(h.doc().items.find(i => i.id === target.id).x !== oldX, "Nudge changed the selected component"); report.edits++;
      const changed = snapshot();
      mark("undo-" + kind); h.act("undo"); await paint(); report.undos++;
      verifyDesign(baseline, "Undo restored every project field and source object");
      mark("redo-" + kind); h.act("redo"); await paint(); report.redos++;
      verifyDesign(changed, "Redo restored the exact edited design");
      mark("restore-" + kind); h.act("undo"); await paint(); report.undos++;
      verifyDesign(baseline, "Final Undo restored the opening design");
    }
    for (const change of outputEdits.reverse()) {
      mark("undo-fabrication"); h.act("undo"); await paint(); report.undos++;
      verifyDesign(change.before, "Undo restored the complete project from before fabrication");
      mark("redo-fabrication"); h.act("redo"); await paint(); report.redos++;
      verifyDesign(change.after, "Redo restored the complete fabrication result");
      mark("restore-fabrication"); h.act("undo"); await paint(); report.undos++;
      verifyDesign(change.before, "The fabrication edit was undone again");
    }
    report.fabricationEdits = outputEdits.length;
    check(trace.timed("test-source-equality", () => sameDesign(authored(beforeChecks), authored(h.project()))),
      "The session restored every source item, stored contour and library field");
    check(!AtriumHost.projectPath, "No source or output write destination was bound"); report.completed = true;
  } catch (error) {
    report.failure = {action, reason: input.private && !error?.tourAssertion ? "Unexpected editor failure (private details withheld)" : String(error?.message || error)};
    if (!input.private) report.failure.status = status();
  } finally {
    report.trace = trace.finish(input.private);
    report.webKitConsole = await native("consoleEvents");
    report.passed = !!report.completed && !report.findings?.length && !report.issueStrings.length &&
      !report.trace.events.some(e => ["console.error", "uncaught", "rejection", "resource-error", "worker-console.error", "worker-error", "worker-message-error", "worker-rejection"].includes(e.type));
    await record();
    await native("log", {ok: report.passed, name: "Real design tour " + input.name, detail: report.passed ? input.theme : action});
  }
  return {passed: report.passed};
}};
