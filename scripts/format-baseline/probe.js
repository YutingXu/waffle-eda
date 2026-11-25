"use strict";
const host = AtriumNavHost;
const native = (op, details = {}) => webkit.messageHandlers.formatBenchmark.postMessage({op, ...details});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok, message) => { if (!ok) throw Error(message); };
const until = async (test, message, timeout = 45000) => {
  const end = performance.now() + timeout;
  while (!test()) {
    if (performance.now() > end) throw Error(message);
    await delay(20);
  }
};
const sha = async string => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(string))),
  byte => byte.toString(16).padStart(2, "0")).join("");
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
await until(() => document.visibilityState === "visible", "Native window has no rendering opportunity", 4000);
AtriumPower.host({occluded: false});
const start = await AtriumLazy.need("AtriumStartPage");
start.open({launch: true});
start.close();
check(AtriumPower.visible(), "WebKit visibility " + document.visibilityState + ", occluded " + AtriumPower.state().occluded);
await nextFrame();
await nextFrame();
const starter = host.project();
let started, model, paint, rendered = false, releasePaint, rejectPaint;
const painted = new Promise((resolve, reject) => { releasePaint = resolve; rejectPaint = reject; });
const stopModel = host.on("replace", () => {
  if (host.project() !== starter) model = performance.now() - started;
});
const stopRender = host.addRenderer((document, info) => {
  if (model !== undefined && info.active && document === host.project().documents[0] && document.items.length) rendered = true;
});
const stopFrame = host.on("frame", () => {
  if (!rendered || !releasePaint) return;
  const resolve = releasePaint;
  releasePaint = null;
  // The active-document render has returned in the editor's own frame. Ask WebKit to acknowledge
  // its next presentation update. The timestamp includes the round trip back to this page.
  native("present").then(() => { paint = performance.now() - started; resolve(); }, rejectPaint);
});
started = performance.now();
await native("open");
let timeout;
try {
  await Promise.race([painted, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("No project frame")), 90000); })]);
} finally { clearTimeout(timeout); stopModel(); stopRender(); stopFrame(); }
const memory = await native("finishOpen");
const project = host.project();
check(AtriumHost.projectPath && !host.isStarter() && !document.querySelector("dialog[open]") &&
  host.currentId() === project.documents[0].id && host.canvas().clientWidth > 0, "The painted editor is not usable");
check(JSON.stringify(project.documents.map(d => d.items.length)) === JSON.stringify(trial.items), "Not every saved document was loaded");
check(model >= 0 && paint >= model && memory.peakRSSBytes > 0 && memory.samples >= 2, "Invalid open measurement");
const cache = await AtriumIO.serializer();
await until(() => !!cache.base(), "The normal idle save cache did not prime");
const selection = WaffleBaselineEdits.select(project, {kicadGlobalLabel: trial.globalLabel});
const target = selection[trial.edit];
check(target?.item, "The selected edit has no target");
host.selectDocument(target.doc.id);
await nextFrame();
const scope = {documents: [target.doc.id], items: [target.item.id]};
if (trial.settle) {
  // Opening an imported native snapshot and visiting a PCB can materialize derived fields. Give the
  // normal edit pipeline one no-op transaction, then write the resulting working base before timing.
  cache.setMode("always");
  host.edit(() => {}, "Settle working copy", [], scope);
  check(host.isDirty() && await host.saveProject(), "Could not establish the saved working base");
}
const baseline = cache.base().state;
const original = trial.settle ? await sha(cache.text(baseline)) : trial.original;
cache.setMode(trial.policy);
function apply(p, picked) {
  const {doc, item} = picked;
  if (trial.edit === "part") {
    Atrium.transformPart(doc, item, p.library.find(d => d.id === item.def), {x: item.x + WaffleBaselineEdits.MOVE_MM});
  } else if (trial.edit === "label") {
    item.text += WaffleBaselineEdits.LABEL_SUFFIX;
  } else {
    doc.items.push(item);
  }
}
host.edit(() => apply(project, target), "Benchmark edit", [target.item.id], scope);
check(host.isDirty(), "The edit did not dirty the project");
const saveStart = performance.now();
const saved = await host.saveProject();
const saveMs = performance.now() - saveStart;
check(saved && !host.isDirty(), "Regular editor Save failed");
const last = cache.stats().lastSave;
check(last?.patch, "The canonical save did not use its primed base");
if (trial.settle) check(last.compacted === (trial.policy === "always"), "The requested save policy was not exercised");
const actualHash = await sha(cache.serialize(project));
const replay = JSON.parse(cache.text(baseline));
const replayTarget = WaffleBaselineEdits.select(replay, {kicadGlobalLabel: trial.globalLabel})[trial.edit];
apply(replay, replayTarget);
const expectedModel = AtriumSaveCache.create().serialize(replay);
const exactEdit = (await sha(expectedModel)) === actualHash;
// Only aggregate differences between the saved native model and the isolated intended operation.
const found = new Set();
if (!exactEdit) {
  function compare(a, b, prefix = "") {
    if (a === b) return;
    if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        // Never include IDs, object names or map keys in the output.
        const field = ["documents","library","items","outline","blobs","bodyModels","rules","layers","pcbDrawing",
          "boardShape","signals","view","variants","parameters","importNotes","jobs","nets","grid","notes"].includes(key) ? key : "?";
        compare(a[key], b[key], prefix.split(".").length < 5 ? (prefix ? prefix + "." : "") + field : prefix);
      }
    } else found.add(prefix);
  }
  compare(JSON.parse(expectedModel), JSON.parse(cache.serialize(project)));
}
const verified = await native("verify", {policy: last.compacted ? "always" : "close", expected: actualHash, original});
if (!last.compacted && !trial.settle) check(await cache.compact(), "Could not compact the confirmed journal for Git inspection");
return {exactEdit, extraFields: [...found].sort(), compacted: last.compacted, modelMs: model, firstPaintMs: paint,
  saveMs, peakRSSBytes: memory.peakRSSBytes, memorySamples: memory.samples, journalBytes: verified.journalBytes,
  patchBytes: last.bytes, firstDocumentKind: project.documents[0].kind};
