"use strict";
// Naming (app/schematic/naming.js): one name in words (DOM-free); then, with LinkeDOM
// under Node, the Naming view (learned cards with Keep / Forget, the two choices, the project's words, never
// lists and declined suggestions, Try a name), the Signals panel's Signals | Naming tabs and grouped
// suggestions, and inline completion on a net name field (faint suggestion, Tab takes it, Escape and
// deleting keep what was typed).
// Run: node tests/schematic/naming.cjs   (scripts/test-jsc.sh naming runs the DOM-free part)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "altium-rules", "query", "signals", "rules", "net-intent-index", "signals-panel", "naming"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, X = AtriumNetIntentIndex, NM = AtriumNaming;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
function project(labels) {
  const p = A.project("Naming", []), sch = p.documents[0];
  labels.forEach((n, k) => sch.items.push({id: "l" + k, kind: "netlabel", text: n, x: 0, y: k * 5}));
  return S(p);
}
const S = p => AtriumSignals.attach(p);

test("describe: one name in words, with its basis", () => {
  const d = n => { const r = NM.describe(n); return r.text + (r.basis ? " (" + r.basis + ")" : ""); };
  assert.equal(d("USB_DP"), "The positive line of the differential pair USB (DP/DM); its partner is USB_DM (by its name)");
  assert.equal(d("3V3"), "A 3.3 V rail (by its name)");
  assert.equal(d("VCC"), "A rail (no voltage in the name) (by its name)");
  assert.equal(d("3V3_PG"), "The power-good signal of the rail 3V3 (by its name)");
  assert.equal(d("GND_ISO"), "An isolated ground (ISO) (by its name)");
  assert.equal(d("nRST"), "A reset control, active low (by its name)");
  assert.equal(d("CLK_25M"), "A clock, 25 MHz (by its name)");
  assert.equal(d("D7"), "Member 7 of the bus D (by its name)");
  assert.equal(d("NetR1_2"), "An automatic name: it says nothing about the net");
  assert.equal(d("FOO"), "No known meaning: Waffle will not guess");
  assert.equal(d("RS485_A"), "A line of the pair RS485; which one is + is set under Choices (by its name)");
  const conv = {...X.conventions(null).effective, stems: {rail: ["VPROG"], ground: [], clock: []}};
  assert.equal(NM.describe("VPROG_A", conv).basis, "by your words");
});

test("conventions file: export the words and choices, import into another project with a preview, one undo step", () => {
  const a = project(["3V3", "1V8"]);
  X.conventionEdits.addWord(a, "stems", "rail", "VPROG");
  X.conventionEdits.addWord(a, "never", "rail", "VSEL");
  X.conventionEdits.set(a, "loneN", "pair");
  X.conventionEdits.keep(a, "activeLow", "_N");
  X.conventionEdits.stopSuggesting(a, {kind: "diff", value: "A/B"});
  a.signals.conventions.tally = {"diff:A/B": [0, 3]};
  const file = X.exportConventions(a);
  assert.deepEqual(file, {format: "atrium-naming", version: 1, project: "Naming", conventions: {keep: {activeLow: "_N"}, stems: {rail: ["VPROG"]}, never: {pair: ["A/B"], rail: ["VSEL"]}, loneN: "pair"}}, "no counts, no declines");
  const b = project(["5V"]);
  X.conventionEdits.addWord(b, "stems", "rail", "VAUX");
  X.conventionEdits.keep(b, "activeLow", "n");
  const text = JSON.stringify(file);
  const plan = X.planImport(b, text);
  assert.deepEqual(plan.changes.map(c => c.kind + " " + c.group + "." + c.key + " " + (typeof c.to === "string" ? c.to : JSON.stringify(c.to))).sort(),
    ["add choice.loneN pair", "add never.pair A/B", "add never.rail VSEL", "add stems.rail VPROG", "replace keep.activeLow _N"]);
  assert.equal(plan.applies, 5); assert.equal(plan.from, "Naming");
  assert.equal(X.planImport(b, file, {prefer: "project"}).changes.find(c => c.group === "keep").kind, "keep", "keep this project's choice");
  assert.equal(b.signals.conventions.stems.rail.length, 1, "the preview edits nothing");
  const msg = X.importConventions(b, file, {prefer: "project"});
  assert.equal(msg, "Naming conventions imported: 4 changes");
  assert.deepEqual(b.signals.conventions.stems.rail, ["VAUX", "VPROG"], "merged, in order");
  assert.equal(b.signals.conventions.keep.activeLow, "n", "kept");
  assert.equal(b.signals.conventions.loneN, "pair");
  assert.equal(X.classify("VPROG_EN", X.conventions(b).effective).role, "railSignal", "the imported word reads");
  assert.equal(X.importConventions(b, file).startsWith("Naming conventions imported: 1"), true, "again, the file's: only the one difference left");
  assert.equal(X.planImport(b, file).changes.length, 0, "nothing left to import");
  assert.throws(() => X.planImport(b, {format: "other"}), /not a Waffle naming conventions file/);
  assert.throws(() => X.planImport(b, "{"), /not a Waffle naming conventions file/);
  assert.throws(() => X.planImport(b, {format: "atrium-naming", version: 9, conventions: {}}), /newer Waffle/);
  // Words are cleaned: lower case, junk and duplicates.
  const c = project([]);
  X.importConventions(c, {format: "atrium-naming", version: 1, conventions: {stems: {rail: ["vbias", "VBIAS", "no spaces!", 3]}, never: {kinds: ["rail", "x"]}}});
  assert.deepEqual(c.signals.conventions.stems.rail, ["VBIAS"]); assert.deepEqual(c.signals.conventions.never.kinds, ["rail"]);
});

test("Create from nets: a pair by polarity, every name pair among more nets, a bus, a tagged group; the same records as accepting a suggestion", () => {
  const p = project(["USB_DP", "USB_DM", "LVDS0_P", "LVDS0_N", "LVDS1_P", "LVDS1_N", "D0", "D1", "D2", "D3", "SIGA", "SIGB", "3V3", "5V"]);
  assert.deepEqual(X.planCreate({kind: "diff", nets: ["USB_DM", "USB_DP"]}).map(g => [g.name, g.positive, g.negative, g.known]), [["USB", "USB_DP", "USB_DM", true]]);
  X.createFrom(p, {kind: "diff", nets: ["USB_DM", "USB_DP"]});
  const usb = p.signals.signals.find(s => s.name === "USB");
  assert.deepEqual(usb.legs, [{polarity: 1, nets: ["USB_DP"]}, {polarity: -1, nets: ["USB_DM"]}]);
  assert.equal(usb.intent.source, "user"); assert.match(usb.intent.confirmed, /^\d{4}-\d\d-\d\d$/); assert.equal(usb.origin, "suggestion");
  assert.deepEqual(p.signals.conventions.tally, {"diff:DP/DM": [1, 0]}, "counted as an accept of the pattern");
  assert.ok(!X.suggest(p).some(g => g.name === "USB"), "no longer suggested");
  X.createFrom(p, {kind: "diff", nets: ["LVDS0_P", "LVDS0_N", "LVDS1_P", "LVDS1_N", "SIGA"]});
  assert.deepEqual(p.signals.signals.filter(s => /^LVDS/.test(s.name)).map(s => s.name), ["LVDS0", "LVDS1"]);
  X.createFrom(p, {kind: "diff", nets: ["SIGB", "SIGA"], name: "SIG"});
  assert.deepEqual(p.signals.signals.find(s => s.name === "SIG").legs.map(l => l.nets[0]), ["SIGB", "SIGA"], "no polarity by name: in the order chosen");
  X.createFrom(p, {kind: "bus", nets: ["D3", "D0", "D2", "D1"]});
  const bus = p.signals.signals.find(s => s.kind === "bus");
  assert.equal(bus.name, "D"); assert.equal(bus.members.length, 4); assert.deepEqual(bus.intent.range, [0, 3]);
  assert.deepEqual(bus.members.map(id => p.signals.signals.find(s => s.id === id).legs[0].nets[0]), ["D0", "D1", "D2", "D3"]);
  assert.equal(X.createFrom(p, {kind: "tag", nets: ["3V3", "5V"], tag: "Power"}), "Tagged 2 nets Power");
  assert.deepEqual(p.signals.nets["3V3"], {tags: ["Power"]}); assert.ok(p.signals.tags.some(t => t.name === "Power"));
  assert.throws(() => X.createFrom(p, {kind: "diff", nets: ["3V3", "5V", "D0"]}), /None of the chosen nets pair/);
  assert.throws(() => X.createFrom(p, {kind: "bus", nets: ["D0"]}), /two or more nets/);
  assert.throws(() => X.createFrom(p, {kind: "tag", nets: ["D0"]}), /Name the tag/);
  assert.throws(() => X.createFrom(p, {kind: "diff", nets: []}), /Choose the nets/);
});

(async () => {
  let parseHTML;
  try { ({parseHTML} = require("linkedom")); } catch { console.log("SKIP naming DOM: linkedom is not installed"); console.log("naming: " + passed + " tests passed"); return; }
  const {document, window} = parseHTML('<html><body><aside id="properties"></aside></body></html>');
  globalThis.document = document; globalThis.window = window; globalThis.Event = window.Event; globalThis.KeyboardEvent = window.KeyboardEvent || window.Event;
  require("../../app/editor/keymap.js");
  require("../../app/editor/nav-common.js");
  require("../../app/ui/dialog.js");
  require("../../app/ui/shortcut.js");
  const key = (target, k, o = {}) => { const e = new window.Event("keydown", {bubbles: true, cancelable: true}); Object.assign(e, {key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o}); target.dispatchEvent(e); return e; };
  const type = (input, value, inputType = "insertText") => { input.value = value; const e = new window.Event("input", {bubbles: true}); e.inputType = inputType; input.dispatchEvent(e); };
  const click = (root, text) => { const b = [...root.querySelectorAll("button")].find(x => x.textContent === text); assert.ok(b, "a button " + text); b.onclick({preventDefault() {}}); };

  test("the Naming view: learned cards, Keep and Forget, choices, words, never lists, declined suggestions, Try a name", () => {
    const p = project(["3V3", "1V8", "2V5", "1V2", "5V0", "nRST", "nCS", "USB_DP", "USB_DM", "RS485_A", "RS485_B"]);
    let edits = 0, info = "";
    const host = {project: () => p, edit: fn => { edits++; fn(); }, info: m => { info = m; }, setHighlight() {}};
    const root = document.createElement("div");
    NM.render(root, host);
    const cards = [...root.querySelectorAll(".nm-card")];
    assert.deepEqual(cards.map(c => c.querySelector(".nm-card-title").textContent), ["Rail names", "Active-low names", "Differential pairs", "Bus members", "Capitals"]);
    const rail = cards[0];
    assert.equal(rail.querySelector(".nm-value").textContent, "3V3 · 5V0");
    assert.equal(rail.querySelector(".nm-badge").textContent, "Learned from 5 names");
    assert.match(rail.querySelector(".nm-use").textContent, /typing 2\.5 gives 2V5/);
    assert.deepEqual([...rail.querySelectorAll(".nm-chip-name")].map(b => b.textContent), ["3V3", "1V8", "2V5", "1V2", "5V0"]);
    click(rail, "Keep");
    assert.equal(p.signals.conventions.keep.rail.id, "3V3 · 5V0");
    assert.equal(root.querySelector(".nm-card .nm-badge").textContent, "Kept by you", "re-rendered after the edit");
    click(root.querySelector(".nm-card"), "Forget");
    assert.deepEqual(p.signals.conventions.forget, ["rail"]);
    click(root.querySelector(".nm-card"), "Use again");
    assert.equal(p.signals.conventions, undefined, "back to learning: nothing stored");
    // Choices: RS-485 A inverting.
    const r = [...root.querySelectorAll('input[name="nm-rs485"]')].find(x => x.value === "B");
    r.checked = true; r.onchange();
    assert.equal(p.signals.conventions.rs485, "B");
    assert.equal(X.suggest(p).find(g => g.name === "RS485").positive, "RS485_B");
    // A word in the dictionary, added with Enter, removed with its ×.
    const add = [...root.querySelectorAll(".nm-add")][0];
    add.value = "vprog"; key(add, "Enter");
    assert.deepEqual(p.signals.conventions.stems.rail, ["VPROG"]);
    const x = [...root.querySelectorAll(".nm-chip-x")].find(b => b.title === "Remove VPROG");
    x.onclick();
    assert.equal(p.signals.conventions.stems, undefined);
    // Declined suggestions: listed, suggested again one by one.
    X.decline(p, X.suggest(p).find(g => g.name === "USB"));
    NM.render(root, host);
    click(root, "Show");
    assert.match(root.querySelector(".nm-declined-list li").textContent, /^USB · pair · \d{4}-\d\d-\d\d/);
    click(root.querySelector(".nm-declined-list"), "Suggest again");
    assert.ok(X.suggest(p).some(g => g.name === "USB"));
    // Try a name.
    const tryIn = root.querySelector(".nm-try-input");
    tryIn.value = "VDD_1V8"; tryIn.oninput();
    assert.equal(root.querySelector(".nm-try-text").textContent, "A 1.8 V rail (by its name).");
    assert.ok(edits >= 6 && info);
  });

  test("the Signals panel: Signals | Naming tabs; suggestions grouped by kind with Accept all", () => {
    const p = project(["USB_DP", "USB_DM", "A0", "A1", "A2", "3V3", "5V0", "GND"]), b = p.documents[1];
    let info = "";
    const host = {project: () => p, doc: () => b, defs: () => new Map(), edit: fn => fn(), info: m => { info = m; }, selection: () => [], setHighlight() {}, zoomTo() {}, registerAction() {}, on() {}, canvas: () => null};
    AtriumSignalsPanel.toggle(host, true);
    const panel = document.querySelector(".panel-signals");
    const groups = [...panel.querySelectorAll(".sig-group")].map(g => g.firstChild.textContent);
    assert.deepEqual(groups, ["Suggested pairs (1)", "Suggested buses (1)", "Rails (2)", "Grounds (1)"]);
    const rails = [...panel.querySelectorAll(".sig-group")].find(g => g.firstChild.textContent === "Rails (2)");
    click(rails, "Accept all");
    assert.deepEqual(p.signals.signals.filter(s => s.intent?.role === "rail").map(s => s.name).sort(), ["3V3", "5V0"]);
    assert.equal(info, "2 suggestions accepted");
    const tab = [...panel.querySelectorAll(".sig-tab")].find(t => t.textContent === "Naming");
    tab.onclick();
    assert.equal(tab.getAttribute("aria-selected"), "true");
    assert.ok(panel.querySelector(".sig-list").hidden && !panel.querySelector(".sig-naming").hidden);
    assert.ok(panel.querySelector(".sig-naming .nm-card"), "the Naming view renders in the panel");
    AtriumSignalsPanel.toggle(host, false);
  });

  test("inline completion: faint suggestion while typing, Tab takes it, Escape and deleting keep what was typed", () => {
    const p = project(["USB_DP", "D0", "D1", "D2", "SPI_MOSI", "SPI_MISO"]);
    const form = document.createElement("form"), label = document.createElement("label"), input = document.createElement("input");
    label.append(input); form.append(label); document.body.append(form);
    let seen = [];
    input.addEventListener("input", () => seen.push(input.value));
    NM.attach(input, {kind: "netlabel", project: () => p});
    type(input, "USB_D");
    const ghost = document.querySelector(".nm-ghost");
    assert.ok(ghost, "the suggestion shows");
    assert.equal(ghost.querySelector(".nm-ghost-rest").textContent, "M");
    assert.equal(input.value, "USB_D", "the field holds only what was typed");
    assert.match(form.querySelector(".nm-complete-line").textContent, /USB_DMpartner of USB_DP/);
    const e = key(input, "Tab");
    assert.ok(e.defaultPrevented, "Tab is taken by the completion");
    assert.equal(input.value, "USB_DM");
    assert.equal(seen.at(-1), "USB_DM", "the field's input handlers see the taken name");
    assert.ok(!document.querySelector(".nm-ghost"));
    // ↓ chooses the next name; Escape drops the suggestion; deleting never completes.
    type(input, "SPI_M");
    assert.equal(document.querySelector(".nm-ghost-rest").textContent, "ISO");
    key(input, "ArrowDown");
    assert.equal(document.querySelector(".nm-ghost-rest").textContent, "OSI");
    const esc = key(input, "Escape");
    assert.ok(esc.defaultPrevented && !document.querySelector(".nm-ghost") && input.value === "SPI_M");
    type(input, "SPI_", "deleteContentBackward");
    assert.ok(!document.querySelector(".nm-ghost"));
    // Without a suggestion, Tab moves on as usual.
    type(input, "ZZZ");
    assert.ok(!key(input, "Tab").defaultPrevented);
    form.remove();
  });

  const atest = async (name, fn) => { await fn(); passed++; console.log("ok - " + name); };
  await atest("the Naming view: Share exports the conventions, Import previews the merge and applies it as one undo step", async () => {
    const a = project(["3V3"]), b = project(["5V"]);
    X.conventionEdits.addWord(a, "stems", "rail", "VPROG");
    X.conventionEdits.set(a, "rs485", "B");
    let saved = null, edits = 0, info = "";
    globalThis.AtriumIO = {exportFile: async (name, text) => { saved = {name, text}; return true; }, pickFile: async () => ({name: "Naming.waffle-naming.json", text: async () => saved.text})};
    const hostA = {project: () => a, edit: fn => { edits++; fn(); }, info: m => { info = m; }, setHighlight() {}};
    const root = document.createElement("div");
    NM.render(root, hostA);
    await [...root.querySelectorAll("button")].find(x => x.textContent === "Export…").onclick();
    assert.equal(saved.name, "Naming.waffle-naming.json");
    assert.deepEqual(JSON.parse(saved.text).conventions, {stems: {rail: ["VPROG"]}, rs485: "B"});
    assert.match(info, /exported to Naming\.waffle-naming\.json/);
    const hostB = {...hostA, project: () => b};
    NM.render(root, hostB);
    await [...root.querySelectorAll("button")].find(x => x.textContent === "Import…").onclick();
    const box = root.querySelector(".nm-import");
    assert.ok(box, "the preview shows");
    assert.equal(box.querySelector(".nm-import-head").textContent, "Importing Naming.waffle-naming.json (from Naming)");
    assert.deepEqual([...box.querySelectorAll(".nm-import-list li")].map(li => li.textContent), ["Addrail word VPROG", "Addchoice rs485: B"]);
    assert.equal(b.signals?.conventions, undefined, "nothing written before Import");
    const before = edits;
    [...box.querySelectorAll("button")].find(x => x.textContent === "Import 2 changes").onclick();
    assert.equal(edits, before + 1, "one undo step");
    assert.deepEqual(b.signals.conventions, {stems: {rail: ["VPROG"]}, rs485: "B"});
    assert.ok(!root.querySelector(".nm-import"), "the preview closes");
    delete globalThis.AtriumIO;
  });

  test("the Signals panel: Create from nets… checks the selection, previews, and creates in one undo step", () => {
    const p = project(["USB_DP", "USB_DM", "D0", "D1", "D2"]), b = p.documents[1];
    b.items.push({id: "u1", kind: "part", ref: "U1", def: "d", x: 0, y: 0, angle: 0, pinNets: {1: "USB_DP", 2: "USB_DM", 3: "D0", 4: "D1", 5: "D2"}}, {id: "t1", kind: "track", net: "USB_DP", layer: "Top", width: .2, points: [[0, 0], [1, 0]]}, {id: "t2", kind: "track", net: "USB_DM", layer: "Top", width: .2, points: [[0, 1], [1, 1]]});
    let info = "", edits = 0;
    const host = {project: () => p, doc: () => b, defs: () => new Map(), edit: fn => { edits++; fn(); }, info: m => { info = m; }, selection: () => ["t1", "t2"], setHighlight() {}, zoomTo() {}, registerAction() {}, on() {}, canvas: () => null};
    AtriumSignalsPanel.toggle(host, true);
    const panel = document.querySelector(".panel-signals");
    [...panel.querySelectorAll(".sig-tab")].find(t => t.textContent === "Signals").onclick();
    click(panel.querySelector(".sig-actions"), "Create from nets…");
    const box = panel.querySelector(".sig-create");
    assert.ok(!box.hidden, "the chooser shows inline");
    const checked = [...box.querySelectorAll(".sig-create-net")].filter(l => l.querySelector("input").checked).map(l => l.textContent);
    assert.deepEqual(checked, ["USB_DM", "USB_DP"], "the selected tracks' nets");
    assert.equal(box.querySelector(".sig-create-preview").textContent, "USB: + USB_DP  − USB_DM");
    const before = edits;
    click(box, "Create");
    assert.equal(edits, before + 1, "one undo step");
    assert.ok(p.signals.signals.some(s => s.name === "USB" && s.kind === "diff"));
    assert.match(info, /Differential signal USB declared/);
    assert.ok(box.hidden, "closed after Create");
    // A bus from three checked nets.
    host.selection = () => [];
    click(panel.querySelector(".sig-actions"), "Create from nets…");
    const bus = [...box.querySelectorAll('input[name="sig-create-kind"]')].find(r => r.value === "bus");
    bus.checked = true; bus.onchange();
    for (const l of box.querySelectorAll(".sig-create-net")) if (/^D\d$/.test(l.textContent)) { const c = l.querySelector("input"); c.checked = true; c.onchange(); }
    assert.equal(box.querySelector(".sig-create-preview").textContent, "Bus D: 3 nets, D0 … D2");
    click(box, "Create");
    assert.ok(p.signals.signals.some(s => s.kind === "bus" && s.name === "D"));
    AtriumSignalsPanel.toggle(host, false);
  });
  console.log("naming: " + passed + " tests passed");
})().catch(e => { console.error(e); process.exit(1); });
