"use strict";
// Annotate mode (review-annotate.js): the target hierarchy and labels (pin → part → net → room),
// value formatting, comment anchors for pins, groups, rooms and areas (review-comments.js keeps
// them following their objects), keyboard "nearby" order, and the mode UI driven through a
// recording DOM: hover, click, Shift+click group, drag area, Ctrl+Enter post, Esc, no HTML sinks,
// and no listeners or renderer while the mode is off.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
for (const m of ["model", "nav-common", "keymap", "ui/shortcut", "crossprobe", "review-comments", "review-annotate"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const C = AtriumReviewComments, N = AtriumReviewAnnotate;

function project() {
  const p = Atrium.project("Annotate");
  const board = Atrium.sheet("pcb", "Board");
  board.id = "board-1";
  p.library = [{id: "def-r", name: "R", footprint: {shapes: [], pads: [{number: "1", name: "A", x: -1, y: 0, w: .6, h: .6}, {number: "2", x: 1, y: 0, w: .6, h: .6}]}}];
  board.items.push({id: "r1", kind: "part", def: "def-r", ref: "R12", value: "10k", x: 10, y: 10, angle: 0, layer: "Top", pinNets: {"1": "VDD", "2": "GND"}},
    {id: "c1", kind: "part", def: "def-r", ref: "C3", value: "100n", x: 20, y: 10, angle: 0, layer: "Top", pinNets: {}},
    {id: "t1", kind: "track", layer: "Top", net: "GND", width: .25, points: [[0, 0], [5, 0]]},
    {id: "v1", kind: "via", x: 5, y: 0, diameter: .6, drill: .3, net: "GND", layer: "Multi"});
  board.rooms = [{id: "room-a", name: "PSU", points: [[0, -5], [30, -5], [30, 20], [0, 20]]}];
  p.documents = [board];
  return p;
}

// ---- labels
assert.equal(N.prettyValue("R12", "10k"), "10 kΩ");
assert.equal(N.prettyValue("R1", "4k7"), "4.7 kΩ");
assert.equal(N.prettyValue("R1", "100"), "100 Ω");
assert.equal(N.prettyValue("C3", "100n"), "100 nF");
assert.equal(N.prettyValue("C3", "1u"), "1 µF");
assert.equal(N.prettyValue("U1", "LM358"), "LM358", "other parts keep their value");
assert.equal(N.prettyValue("R1", "10k 1%"), "10k 1%", "anything unusual is shown as written");
assert.equal(N.describe({kind: "track", width: .25}, "GND", "mm"), "Track · 0.25 mm · GND");
assert.equal(N.describe({kind: "via", diameter: .6}, "GND", "mm"), "Via · 0.6 mm · GND");

// ---- the hierarchy: pad/pin → part → net → room
const p = project(), board = p.documents[0], defs = new Map(p.library.map(d => [d.id, d]));
let L = N.levels(board, defs, board.items[0], [9, 10]);
assert.deepEqual(L.map(l => l.kind), ["pin", "part", "net", "room"]);
assert.equal(L[0].label, "Pin R12.1 A", "a pin shows part.pin and the pin name");
assert.equal(L[1].label, "R12 · 10 kΩ");
assert.equal(L[2].label, "Net VDD");
assert.equal(L[3].label, "Room PSU");
assert.deepEqual(L.map(l => l.crumb), ["R12.1", "R12", "VDD", "PSU"], "the breadcrumb");
assert.ok(L[0].box[2] - L[0].box[0] < 1, "the pin box is the pad, not the part");
L = N.levels(board, defs, board.items[0], [10, 10]);
assert.deepEqual(L.map(l => l.kind), ["part", "room"], "off the pads: the part, then its room");
L = N.levels(board, defs, board.items[2], [2, 0]);
assert.deepEqual(L.map(l => l.kind), ["track", "net", "room"]);
assert.equal(L[0].label, "Track · 0.25 mm · GND");
const netBox = N.levelBox(board, defs, L[1], [2, 0]);
assert.ok(netBox && netBox[0] <= 0 && netBox[2] >= 5.3, "a net's box covers its copper, filled in on demand");
assert.deepEqual(N.levels(board, defs, null, [1, 1]), [], "empty canvas has no levels");

// ---- anchors: pin, group, room, area, net; they follow their objects
const pinAnchor = N.anchorFor(N.levels(board, defs, board.items[0], [9, 10])[0], [9, 10]);
assert.equal(pinAnchor.kind, "pin"); assert.equal(pinAnchor.pin, "1"); assert.equal(pinAnchor.id, "r1");
const t1 = C.add(p, {doc: "board-1", anchor: pinAnchor, text: "Check the pull-up", author: "A"});
board.items[0].x = 14;
let at = C.locate(board, defs, C.thread(p, t1.id));
assert.ok(at.live && Math.abs((at.box[0] + at.box[2]) / 2 - 13) < 1e-9, "a pin comment follows its part");
const g = [N.levels(board, defs, board.items[0], [14, 10]).find(l => l.kind === "part"), N.levels(board, defs, board.items[1], [20, 10])[0]];
for (const x of g) N.levelBox(board, defs, x, null);
const groupAnchor = N.anchorFor({group: g, kind: "group"}, [0, 0]);
assert.equal(groupAnchor.kind, "group"); assert.deepEqual(groupAnchor.ids, ["r1", "c1"]);
assert.match(groupAnchor.label, /^2 objects: R12, C3$/);
const t2 = C.add(p, {doc: "board-1", anchor: groupAnchor, text: "Same footprint?", author: "A"});
board.items[1].x = 30;
at = C.locate(board, defs, C.thread(p, t2.id));
assert.ok(at.box[2] > 30, "a group's box follows its members");
const roomAnchor = N.anchorFor(N.levels(board, defs, board.items[2], [2, 0]).find(l => l.kind === "room"), [2, 0]);
const t3 = C.add(p, {doc: "board-1", anchor: roomAnchor, text: "Keep this room clear", author: "A"});
board.rooms[0].points = board.rooms[0].points.map(([x, y]) => [x + 1, y]);
assert.equal(C.locate(board, defs, C.thread(p, t3.id)).box[0], 1, "a room comment follows the room");
const area = N.areaLevel([4, 6], [1, 2], "mm");
assert.deepEqual(area.box, [1, 2, 4, 6]); assert.equal(area.label, "Area 3 mm × 4 mm");
assert.equal(N.anchorFor(area, [0, 0]).kind, "area");
const point = N.anchorFor(N.pointLevel([3, 4]), [3, 4]);
assert.deepEqual([point.kind, point.at], ["point", [3, 4]]);
assert.throws(() => C.add(p, {doc: "board-1", anchor: {kind: "group", ids: [], at: [0, 0]}, text: "x"}), /group comment names 1 to/);
assert.throws(() => C.add(p, {doc: "board-1", anchor: {kind: "group", ids: Array.from({length: 201}, (_, i) => "i" + i), at: [0, 0]}, text: "x"}), /group comment/);
Atrium.validate(p);
// MCP list keeps the new kinds (design text stays under untrusted_design_text).
{
  const env = {project: () => p, mutable: () => p, touched() {}, page: items => ({items, total: items.length, next_offset: null})};
  const listed = C.headless({op: "list", status: "all"}, env);
  assert.deepEqual(listed.items.map(i => i.anchor.kind).sort(), ["group", "pin", "room"]);
}

// ---- keyboard: nearest objects first, then the smallest
{
  const near = N.nearby(board, defs, board.items, [5.2, .2]);
  assert.equal(near[0].id, "v1", "the via under the point first, then the track beside it");
  assert.equal(near[1].id, "t1");
}

// ---- drawing helpers allocate nothing per call and accept a recording context
{
  const calls = [];
  const ctx = new Proxy({}, {get: (o, k) => k in o ? o[k] : (...a) => calls.push(k), set: (o, k, v) => { o[k] = v; return true; }});
  C.drawTarget(ctx, 0, 0, 2, 1, .1, "rgb(1,2,3)", 1, {halo: "rgb(0,0,0)"});
  assert.ok(calls.includes("arcTo") && calls.includes("fill") && calls.includes("stroke"));
  calls.length = 0;
  C.drawPins(ctx, [{id: "x", at: [0, 0], number: 1, status: "open"}], {scale: 10}, {drop: new Map([["x", .5]]), colours: {accent: "#000", on: "#fff", muted: "#888", ring: "#fff", shadow: "#000"}});
  assert.ok(calls.includes("fill"), "a dropping pin draws");
}

// ---- the mode, driven through a recording DOM
{
  const violations = [], listeners = new Map();
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this._text = ""; this.hidden = false; this.parentElement = null;
      const cls = new Set(); this.classList = {add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c), contains: c => cls.has(c)}; }
    set innerHTML(v) { violations.push("innerHTML"); } get innerHTML() { return ""; }
    insertAdjacentHTML() { violations.push("insertAdjacentHTML"); }
    set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (/^on/i.test(k) || k === "href" || k === "src") violations.push("attribute " + k); }
    getAttribute(k) { return this.attributes[k] ?? null; } hasAttribute(k) { return Object.hasOwn(this.attributes,k); } removeAttribute(k) { delete this.attributes[k]; }
    append(...n) { for (const c of n) { if (c.parentElement) c.parentElement.children = c.parentElement.children.filter(x => x !== c); c.parentElement = this; this.children.push(c); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    before(n) { this.parentElement?.append(n); }
    contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
    closest() { return null; } querySelector() { return null; } querySelectorAll() { return []; }
    addEventListener(t, f) { (this.handlers ||= {})[t] = f; } focus() { document.activeElement = this; } remove() {}
    getBoundingClientRect() { return {left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600}; }
    get offsetWidth() { return 320; } get offsetHeight() { return 140; } get clientWidth() { return 800; } get clientHeight() { return 600; }
    get offsetLeft() { return 0; } get offsetTop() { return 0; }
    setPointerCapture() {}
  }
  const stage = new Node("div"), canvas = new Node("canvas"), status = new Node("span");
  stage.append(canvas);
  const body = new Node("body"); body.append(stage, status);
  const doc0 = {createElement: t => Object.assign(new Node(t), {ownerDocument:doc0}), createTextNode: t => ({textContent: t}), body, documentElement: new Node("html"), activeElement: null,
    getElementById: id => id === "status" ? status : null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}};
  const saved = {document: globalThis.document, NC: globalThis.AtriumNavCommon, N: globalThis.AtriumReviewAnnotate, add: globalThis.addEventListener, rm: globalThis.removeEventListener,
    raf: globalThis.requestAnimationFrame};
  const q = project(), qb = q.documents[0], qdefs = new Map(q.library.map(d => [d.id, d]));
  const view = {scale: () => 10, flipped: () => false, worldToScreen: ([x, y]) => [x * 10, y * 10], screenToWorld: ([x, y]) => [x / 10, y / 10],
    query: () => qb.items};
  let renderers = new Set(), edits = 0, infos = [];
  const host = {project: () => q, doc: () => qb, defs: () => qdefs, units: () => "mm", tool: () => "select", setTool() {}, canvas: () => canvas, view: () => view,
    panes: () => [{canvas, view, docId: qb.id, active: true}], selectable: () => true, edit: fn => { edits++; fn(); }, info: t => infos.push(t), redraw() {}, redrawOverlay() {}, invalidate() {},
    hit: (c, x, y) => { const pt = [x / 10, y / 10]; const item = qb.items.find(i => { const b = AtriumNavCommon.itemBox(qb, qdefs, i); return b && pt[0] >= b[0] - .2 && pt[0] <= b[2] + .2 && pt[1] >= b[1] - .2 && pt[1] <= b[3] + .2; }) || null; return {doc: qb, item, point: pt}; },
    addRenderer: f => { renderers.add(f); return () => renderers.delete(f); }, registerAction() {}, on() {}, pointer: () => null};
  globalThis.document = doc0;
  globalThis.addEventListener = (t, f) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(f); };
  globalThis.removeEventListener = (t, f) => listeners.get(t)?.delete(f);
  globalThis.requestAnimationFrame = () => 1;
  globalThis.AtriumNavCommon = {...saved.NC, ready: () => {}, setChecked() {}, isMac: () => false};
  try {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../../app/history/review-annotate.js"), "utf8"));
    const M = globalThis.AtriumReviewAnnotate;
    M.attach(host);
    const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
    assert.equal(count(), 0, "no listeners while the mode is off"); assert.equal(renderers.size, 0, "no renderer while the mode is off");
    M.enter();
    assert.ok(M.isOn()); assert.equal(renderers.size, 1); assert.ok(count() >= 5);
    const fire = (t, e) => { for (const f of [...(listeners.get(t) || [])]) f({target: canvas, button: 0, buttons: 0, pointerId: 1, preventDefault() {}, stopImmediatePropagation() {}, ...e}); };
    // hover the pin, step up with Alt, back down
    fire("pointermove", {clientX: 90, clientY: 100});
    assert.equal(M.state().label, "Pin R12.1 A"); assert.deepEqual(M.state().crumbs, ["R12.1", "R12", "VDD", "PSU"]);
    fire("keydown", {key: "Alt"});
    assert.equal(M.state().label, "R12 · 10 kΩ"); assert.equal(M.state().level, 1);
    fire("keydown", {key: "Alt"});
    assert.equal(M.state().label, "Net VDD");
    fire("keydown", {key: "Alt", shiftKey: true}); fire("keydown", {key: "Alt", shiftKey: true});
    assert.equal(M.state().level, 0);
    // click locks and opens the composer; Ctrl+Enter posts
    fire("pointerdown", {clientX: 90, clientY: 100}); fire("pointerup", {clientX: 90, clientY: 100});
    assert.equal(M.state().locked, "Pin R12.1 A"); assert.ok(M.state().composer);
    const composer = stage.children.find(n => n.className?.split(" ").includes("ann-composer"));
    const text = composer.children[0].children.find(n => n.className?.split(" ").includes("ann-c-text"));
    assert.equal(doc0.activeElement, text, "the composer takes focus");
    text.value = "<img src=x onerror=alert(1)> check"; text.oninput();
    composer.handlers.keydown({key: "Enter", ctrlKey: true, preventDefault() {}, stopPropagation() {}});
    assert.equal(edits, 1); assert.ok(!M.state().composer, "posting closes the composer");
    let list = C.threads(q, {status: "all"});
    assert.equal(list.length, 1); assert.equal(list[0].anchor.kind, "pin"); assert.equal(list[0].text, "<img src=x onerror=alert(1)> check", "text is stored as typed, never parsed");
    // Shift+click two parts: one group comment
    fire("pointermove", {clientX: 100, clientY: 95});
    fire("pointerdown", {clientX: 100, clientY: 95, shiftKey: true}); fire("pointerup", {clientX: 100, clientY: 95, shiftKey: true});
    fire("pointermove", {clientX: 200, clientY: 95});
    fire("pointerdown", {clientX: 200, clientY: 95, shiftKey: true}); fire("pointerup", {clientX: 200, clientY: 95, shiftKey: true});
    assert.equal(M.state().group, 2); assert.match(M.state().locked, /^2 objects/);
    text.value = "Same value?"; composer.handlers.keydown({key: "Enter", metaKey: true, preventDefault() {}, stopPropagation() {}});
    list = C.threads(q, {status: "all"});
    assert.deepEqual(list.find(t => t.anchor.kind === "group").anchor.ids, ["r1", "c1"]);
    // drag an area on empty canvas
    fire("pointermove", {clientX: 400, clientY: 400});
    fire("pointerdown", {clientX: 400, clientY: 400}); fire("pointermove", {clientX: 450, clientY: 430, buttons: 1}); fire("pointerup", {clientX: 450, clientY: 430});
    assert.match(M.state().locked, /^Area 5 mm × 3 mm$/);
    // Esc cancels the composer, a second Esc leaves the mode
    fire("keydown", {key: "Escape", target: body});
    assert.ok(!M.state().composer && !M.state().locked);
    // keyboard cycling announces nearby objects
    fire("keydown", {key: "Tab", target: canvas});
    assert.ok(M.state().label, "Tab picks a nearby object");
    fire("keydown", {key: "Escape", target: canvas});
    assert.ok(!M.isOn());
    assert.equal(count(), 0, "leaving removes every listener"); assert.equal(renderers.size, 0);
    // right-click › Add Comment opens the composer straight on the object
    M.commentOn(qb.items[2], [2, 0]);
    assert.ok(M.isOn() && M.state().composer); assert.equal(M.state().locked, "Track · 0.25 mm · GND");
    M.exit();
    assert.deepEqual(violations, [], "no HTML sinks");
  } finally {
    globalThis.document = saved.document; globalThis.AtriumNavCommon = saved.NC; globalThis.AtriumReviewAnnotate = saved.N;
    globalThis.addEventListener = saved.add; globalThis.removeEventListener = saved.rm; globalThis.requestAnimationFrame = saved.raf;
  }
}
console.log("PASS review annotate: labels, pin/part/net/room hierarchy, anchors that follow pins, groups and rooms, nearby order, drawing helpers, the mode (hover, Alt, click, Shift+click group, drag area, post, Esc, Tab, context menu) with no listeners while off");
