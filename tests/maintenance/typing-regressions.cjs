"use strict";
// Regressions for bugs the type check found (docs/typing.md). Each case drives
// the real module through a small fake DOM, so it runs under Node and scripts/test-jsc.sh alike.
const assert = require("node:assert/strict");

// ------------------------------------------------------------------ a minimal DOM
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {};
    this.dataset = {}; this.style = {setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k] ?? ""; }}; this.hidden = false; this.value = ""; this.listeners = {}; this._text = "";
    this.className = "";
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.classes(), ...names])].join(" "); },
      remove: (...names) => { this.className = this.classes().filter(name => !names.includes(name)).join(" "); },
      contains: name => this.classes().includes(name),
      toggle: (name, on) => { if (on ?? !this.classList.contains(name)) this.classList.add(name); else this.classList.remove(name); }
    };
  }
  classes() { return this.className.match(/\S+/g) || []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(t) { this.children = []; this._text = String(t); }
  get isConnected() { return !!this.parentNode; }
  append(...nodes) { for (const n of nodes) { const c = typeof n === "string" ? Object.assign(new FakeNode("#text"), {_text: n}) : n; c.remove?.(); c.parentNode = this; this.children.push(c); } }
  prepend(...nodes) { const old = this.children; this.children = []; this.append(...nodes); this.children.push(...old); }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ""; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; } }
  replaceWith(...nodes) {
    const parent = this.parentNode; if (!parent) return;
    const at = parent.children.indexOf(this), after = parent.children.slice(at + 1);
    parent.children = parent.children.slice(0, at); this.parentNode = null; parent.append(...nodes); parent.children.push(...after);
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) {
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key in this.dataset) return String(this.dataset[key]);
    }
    return Object.hasOwn(this.attributes, k) ? this.attributes[k] : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  dispatch(type, e = {}) {
    const ev = {type, target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...e};
    for (const f of [...(this.listeners[type] || [])]) f(ev);
    this["on" + type]?.(ev);
  }
  click() { this.dispatch("click"); }
  focus() {} blur() {} showModal() { this.open = true; } show() { this.open = true; } close() { this.open = false; this.dispatch("close"); }
  add(option) { this.append(option); if (this.value === "") this.value = option.value; } // a <select> shows its first option
  getContext() { return null; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100}; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  find(fn) { return this.all().find(fn) || null; }
  // This fixture needs simple selectors, selector lists and a trailing :not().
  matches(selectors) {
    return selectors.split(/,(?![^()]*\))/).some(raw => {
      const selector = raw.trim(), negation = selector.match(/:not\((.*)\)$/);
      const base = negation ? selector.slice(0, negation.index) : selector;
      const attributes = [...base.matchAll(/\[([\w-]+)(?:="?(.*?)"?)?\]/g)];
      const [tag, ...classes] = base.replace(/\[[^\]]+\]/g, "").split(".");
      return (!tag || tag.toUpperCase() === this.tagName)
        && classes.every(name => this.classList.contains(name))
        && attributes.every(([, key, value]) => this.hasAttribute(key) && (value === undefined || this.getAttribute(key) === value))
        && (!negation || !this.matches(negation[1]));
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) { return this.all().slice(1).filter(node => node.matches(selector)); }
}
function installDOM() {
  const body = new FakeNode("body");
  const create = tag => Object.assign(new FakeNode(tag), {ownerDocument:globalThis.document});
  globalThis.document = {body, documentElement: new FakeNode("html"), activeElement: null,
    createElement: create, createElementNS: (_, t) => create(t), createTextNode: t => Object.assign(new FakeNode("#text"), {_text: t}),
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), getElementById: () => null, addEventListener() {}, removeEventListener() {}};
  globalThis.Option = class extends FakeNode { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } };
  return body;
}
const body = installDOM();
require("../../app/editor/nav-common.js");
require("../../app/ui/dialog.js");
require("../../app/editor/shell.js");
const realTimers = {set: globalThis.setTimeout, clear: globalThis.clearTimeout};

// ------------------------------------------------------------------ 1. keymap-editor.js
// Recording a key in Preferences › Keyboard Shortcuts called an undefined `display` (it is
// api.display), so the first key pressed threw a ReferenceError and nothing was recorded.
{
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {};
  require("../../app/editor/keymap.js");
  require("../../app/ui/shortcut.js");
  require("../../app/ui/kit.js"); // AtriumKeymapEditor depends on AtriumUIKit (lazy.js) for its icon buttons
  require("../../app/editor/keymap-editor.js");
  const keymap = globalThis.AtriumKeymap;
  for (const mac of [false, true]) {
    keymap.setPlatform(mac);
    const bindings = [{key: "Mod+S", when: "", index: 0}];
    const added = [];
    const api = {
      ...keymap,
      presets: () => [{id: "atrium", title: "Waffle"}], setPreset() {}, resetAll() {}, conflicts: () => [],
      table: () => ({byCommand: new Map([["save", bindings]])}),
      commands: () => [{id: "save", title: "Save", category: "File", when: ""}],
      kinds: () => ({schematic: true, pcb: true}), describeWhen: w => w || "",
      replaceBinding: (id, i, text) => added.push(text),
      addBinding: (id, text) => added.push(text), removeBinding() {}, setWhen() {}, resetCommand() {}, onChange: () => () => {},
      importJSON: () => [], exportJSON: () => "{}"};
    const I = {setOpen() {}, presetName: () => "atrium", presetTitle: () => "Waffle", userCount: () => 0,
      effective: () => ({source: "default"})};
    globalThis.AtriumKeymap = api;
    const d = AtriumKeymapEditor.open(api, I, {});
    assert.ok(body.children.includes(d), "the dialog opens");
    assert.ok(d.classList.contains("ui-dialog") && d.querySelector("h2").classList.contains("ui-dialog-title"),
      "the real shell adopts the shortcut editor");
    const keys = d.find(n => n.tagName === "BUTTON" && n.className === "ui-shortcut-edit");
    assert.ok(keys, "a key chip for Save");
    keys.click();
    const recording = d.find(n => n.className === "ui-shortcut-recorder");
    assert.ok(recording, "clicking the chip starts recording");
    d.dispatch("keydown", {key: "k", code: "KeyK", ctrlKey: !mac, metaKey: mac});
    const chord = recording.children[0].children[0];
    assert.equal(chord.tagName, "KBD");
    assert.deepEqual(chord.querySelectorAll(".ui-shortcut-visual").map(node=>node.textContent), [mac ? "⌘" : "Ctrl", "K"],
      "the recorded chord uses the platform renderer");
    assert.equal(chord.querySelector(".shortcut-spoken").textContent, mac ? "Command+K" : "Control+K");
    d.dispatch("keydown", {key: "Enter", code: "Enter"});
    assert.deepEqual(added, ["Mod+K"], "Enter saves the recorded chord");
    d.close();
  }
  delete globalThis.AtriumKeymap;
  globalThis.setTimeout = realTimers.set; globalThis.clearTimeout = realTimers.clear;
}

// ------------------------------------------------------------------ 2. board-shape-ui.js
// Design › Board Shape › Import DXF: choosing "Graphics on a layer" read an undefined `doc`
// (the board is live()), so the import options vanished behind a ReferenceError.
async function importDXF() {
  for (const f of ["model.js", "board-shape.js", "board-shape-sources.js", "pcb-draw.js", "dxf.js", "board-shape-ui.js"]) require(require("../support/app-source-paths.cjs").appFile(f));
  const p = Atrium.project("DXF"), board = p.documents.find(d => d.kind === "pcb");
  board.items.push({id: "silk1", kind: "graphic", layer: "Mechanical 7", points: [[0, 0], [5, 0]], width: .1},
    {id: "silk2", kind: "graphic", layer: "Top Overlay", points: [[0, 1], [5, 1]], width: .1});
  const dxf = ["0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "8", "OUTLINE", "10", "0", "20", "0", "11", "40", "21", "0",
    "0", "LINE", "8", "OUTLINE", "10", "40", "20", "0", "11", "40", "21", "30",
    "0", "LINE", "8", "OUTLINE", "10", "40", "20", "30", "11", "0", "21", "30",
    "0", "LINE", "8", "OUTLINE", "10", "0", "20", "30", "11", "0", "21", "0",
    "0", "ENDSEC", "0", "EOF"].join("\n");
  const infos = [];
  const ctx = {doc: board, project: p, defs: new Map(), currentProject: () => p, info: t => infos.push(t), edit: fn => fn(), selection: () => [],
    pickFile: async () => ({name: "board.dxf", text: async () => dxf})};
  const d = AtriumBoardShapeUI.open(ctx, {tab: "import"});
  assert.ok(d, "the Board Shape dialog opens on a board");
  const footer = d.querySelector(".ui-dialog-actions");
  assert.equal(footer.children.find(n => n.textContent === "Close").dataset.variant, "secondary", "the real shell adopts the Board Shape actions");
  const importAs = () => d.find(n => n.tagName === "SELECT" && n.attributes["aria-label"] === "Import as");
  const choose = d.find(n => n.tagName === "BUTTON" && n.textContent === "Choose DXF file…");
  assert.ok(choose);
  await choose.onclick();
  assert.ok(importAs(), "the DXF loaded and its options are shown");
  importAs().value = "graphics";
  importAs().onchange(); // threw "doc is not defined"
  const layer = d.find(n => n.tagName === "SELECT" && n.attributes["aria-label"] === "Layer");
  assert.ok(layer, "the target layer picker is shown");
  const names = layer.children.map(o => o.value);
  assert.ok(names.includes("Mechanical 1") && names.includes("Top Overlay") && names.includes("Mechanical 7"), "the picker offers the board's own layers: " + names.join(", "));
}

// These owners do work directly or through dedicated clients. Exercise the same
// recorder across their normal boundaries, including an idle and a retired lease.
async function sharedPerformanceOwners() {
  const {appFile} = require("../support/app-source-paths.cjs");
  for (const file of ["diagnostics", "erc", "connectivity", "router", "autorouter", "pdn", "impedance", "field-solver", "hierarchy", "bom"])
    require(appFile(file + ".js"));
  const D = AtriumDiagnostics, secret = "fixture private project";
  const project = Atrium.project(secret), defs = new Map();
  const sheet = project.documents.find(d => d.kind === "schematic"), board = project.documents.find(d => d.kind === "pcb");
  sheet.items.push({id:"wire", kind:"wire", net:secret, points:[[0, 0], [1, 0]]});
  const graph = () => Atrium.connectivity(sheet, defs);
  assert.equal(graph().byWire.get("wire"), secret);
  assert.deepEqual(D.performanceSnapshot().rows, [], "ordinary work leaves the recorder off");

  const lease = D.startPerformance();
  try {
    assert.equal(graph().byWire.get("wire"), secret);
    assert.ok(AtriumERC.run(project).messages);
    const builds = () => D.performanceSnapshot().rows.find(row =>
      row.component === "schematic" && row.operation === "build")?.counts.completed || 0;
    const before = builds();
    assert.ok(AtriumHierarchy.compile(project).instances.length);
    assert.equal(builds(), before + 1, "direct hierarchy assembly is observable independently of ERC");
    assert.deepEqual(AtriumBOM.build(AtriumBOM.collect(project)), []);
    const route = AtriumRouter.begin(board, defs, {net:secret, start:[0, 0], layer:"Top"});
    const preview = route.move([1, 0]);
    assert.equal(route.move([1, 0]), preview, "snap-cell memo hits do no routing work");
    const batch = AtriumAutorouter.prepare(board, defs, {}).job;
    assert.ok((await AtriumAutorouter.run(batch, {foreground:true}).promise).stats);

    const adapt = {compute: job => ({value: job.input}), makeWorker: () => null};
    const finished = AtriumPDN.runSolver({input:7}, {foreground:true}, adapt);
    const cancelled = AtriumPDN.runSolver({input:9}, {foreground:true}, adapt);
    cancelled.cancel();
    await assert.rejects(cancelled.promise, /Cancelled/);
    assert.equal((await finished.promise).value, 7);
    assert.ok((await AtriumFieldSolver.async({structure:"microstrip", w:1, h:1, er:1})).ok);

    const snapshot = D.performanceSnapshot();
    const counts = (component, operation) => snapshot.rows.find(row => row.component === component && row.operation === operation)?.counts;
    for (const [component, operation] of [["schematic","compute"], ["routing","compute"], ["routing","request"],
      ["erc","check"], ["analysis","request"], ["manufacturing","compute"], ["manufacturing","build"]]) {
      assert.equal(counts(component, operation)?.completed, 1, component + "/" + operation + " reports its real operation");
    }
    for (const [component, operation] of [["analysis","request"], ["routing","request"]]) {
      assert.equal(counts(component, operation)?.ready, 1);
    }
    const solve = counts("analysis", "compute");
    assert.deepEqual([solve.queued, solve.started, solve.ready, solve.completed, solve.cancelled], [2, 1, 1, 1, 1]);
    assert.equal(JSON.stringify(D.performanceSnapshot({shareable:true})).includes(secret), false);
  } finally { lease.stop(); }
  const stopped = D.performanceSnapshot();
  graph();
  assert.deepEqual(D.performanceSnapshot(), stopped, "a stopped recorder gains no work from any producer");
}

const restoreWorker = require("../support/import-worker.cjs")({client: true});
globalThis.__testDone = importDXF().finally(restoreWorker).then(sharedPerformanceOwners).then(() => console.log("typing-regressions: ok"));
