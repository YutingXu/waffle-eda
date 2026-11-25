"use strict";
// Review comments (review-comments.js): the stored model,
// anchors that follow moved objects, merge-friendly storage, and the
// security test with hostile comment text rendered by the real panel code into a recording DOM.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
for (const m of ["model", "proposal", "review-comments"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const C = AtriumReviewComments;

function project() {
  const p = Atrium.project("Review");
  const board = Atrium.sheet("pcb", "Board"), sheet = Atrium.sheet("schematic", "Sheet");
  board.id = "board-1"; sheet.id = "sheet-1";
  p.library = [{id: "def-r", name: "R", footprint: {shapes: [], pads: [{number: "1", x: -1, y: 0, w: .6, h: .6}, {number: "2", x: 1, y: 0, w: .6, h: .6}]}}];
  board.items.push({id: "u1", kind: "part", def: "def-r", ref: "R1", value: "10k", x: 10, y: 10, angle: 0, layer: "Top"},
    {id: "t1", kind: "track", layer: "Top", net: "GND", width: .25, points: [[0, 0], [5, 0]]},
    {id: "v1", kind: "via", x: 5, y: 0, diameter: .6, drill: .3, net: "GND", layer: "Multi"});
  p.documents = [board, sheet];
  return p;
}

// ---- model: add, reply, resolve, reopen, mentions, filter, numbering
const p = project(), defs = new Map(p.library.map(d => [d.id, d])), board = p.documents[0];
assert.equal(C.threads(p).length, 0);
const opts = C.candidates(board, defs, board.items[1], [2, 0]);
assert.deepEqual(opts.map(o => o.kind), ["track", "net", "point"], "a track offers the track, its net and the point");
assert.equal(opts[1].net, "GND");
assert.deepEqual(C.candidates(board, defs, null, [1, 2]).map(o => o.kind), ["point"]);
const partAnchor = C.candidates(board, defs, board.items[0], [10, 10])[0];
assert.equal(partAnchor.kind, "part"); assert.equal(partAnchor.label, "R1");
const t1 = C.add(p, {doc: "board-1", anchor: partAnchor, text: "Check R1 value with @alice and @bob.", author: "Carol", now: "2026-11-01T10:00:00Z", id: "c-one"});
const t2 = C.add(p, {doc: "board-1", anchor: opts[1], text: "GND stitching looks thin", author: "Dan", now: "2026-11-01T11:00:00Z", id: "c-two"});
const t3 = C.add(p, {doc: "sheet-1", anchor: {kind: "point", at: [3, 4]}, text: "Pull-up missing?", author: "Eve", now: "2026-11-01T09:00:00Z", id: "c-three"});
assert.deepEqual(C.mentions(t1.text), ["alice", "bob"]);
assert.deepEqual(C.segments("hi @alice!").map(s => [s.text, !!s.mention]), [["hi ", false], ["@alice", true], ["!", false]]);
assert.deepEqual(C.mentions("mail a@b.com"), [], "an e-mail address is not a mention");
C.reply(p, "c-one", {text: "Changed to 4.7k", author: "Alice", now: "2026-11-01T12:00:00Z", id: "r-one"});
let list = C.threads(p, {doc: "board-1"});
assert.deepEqual(list.map(t => [t.id, t.number, t.replies.length]), [["c-one", 1, 1], ["c-two", 2, 0]], "oldest first, numbered per document");
C.setStatus(p, "c-one", "resolved", {author: "Carol", now: "2026-11-02T00:00:00Z"});
assert.deepEqual(C.threads(p, {doc: "board-1"}).map(t => t.id), ["c-two"], "the default filter shows open threads");
assert.deepEqual(C.threads(p, {doc: "board-1", status: "resolved"}).map(t => t.id), ["c-one"]);
assert.equal(C.threads(p, {status: "all"}).length, 3);
assert.deepEqual(C.threads(p, {status: "all", query: "4.7K"}).map(t => t.id), ["c-one"], "search covers replies");
assert.equal(C.thread(p, "c-one").resolved.by, "Carol");
C.setStatus(p, "c-one", "open");
assert.equal(C.thread(p, "c-one").resolved, undefined, "reopening clears the resolution");
assert.throws(() => C.add(p, {doc: "board-1", anchor: partAnchor, text: "   "}), /Write a comment/);
assert.throws(() => C.add(p, {doc: "nope", anchor: partAnchor, text: "x"}), /no document/);
assert.throws(() => C.add(p, {doc: "board-1", anchor: {kind: "script", at: [0, 0]}, text: "x"}), /part, net, track, area or point/);
assert.throws(() => C.reply(p, "c-missing", {text: "x"}), /no comment thread/);

// ---- anchors follow their object; a deleted object leaves the pin where it was
let at = C.locate(board, defs, C.thread(p, "c-one"));
assert.ok(at.live); assert.deepEqual(at.at.map(v => +v.toFixed(3)), [10, 9.7]);
board.items[0].x = 20;
at = C.locate(board, defs, C.thread(p, "c-one"));
assert.deepEqual(at.at.map(v => +v.toFixed(3)), [20, 9.7], "the pin follows the moved part");
const saved = board.items.shift();
at = C.locate(board, defs, C.thread(p, "c-one"));
assert.ok(!at.live); assert.deepEqual(at.at.map(v => +v.toFixed(3)), [10, 9.7], "a deleted part leaves the pin at its last place");
board.items.unshift(saved);

// ---- storage: valid project, sorted keyed records, one block per record; proposals carry them
Atrium.validate(p);
const text = JSON.stringify(p, Object.keys(p).sort(), 2);
void text;
assert.deepEqual(Object.keys(p.review.records).sort(), ["c-one", "c-three", "c-two", "r-one"]);
assert.equal(p.review.records["r-one"].thread, "c-one", "a reply is its own record");
const before = JSON.parse(JSON.stringify(p));
C.add(p, {doc: "board-1", anchor: {kind: "point", at: [1, 1]}, text: "new", author: "Z", id: "c-new", now: "2026-11-03T00:00:00Z"});
const built = AtriumProposal.build(before, p, {allowV1: false});
assert.equal(built.ops, 1, "one added comment is one proposal operation");
const applied = JSON.parse(JSON.stringify(before));
AtriumProposal.apply(applied, built.proposal);
assert.deepEqual(applied.review, p.review, "a proposal applies the comment");
// Merge: two branches each add a comment; their records are disjoint keys, so a three-way merge
// of the keyed map is the union (what Git's line merge sees as separate blocks).
const left = JSON.parse(JSON.stringify(before)), right = JSON.parse(JSON.stringify(before));
C.add(left, {doc: "board-1", anchor: {kind: "point", at: [0, 0]}, text: "L", author: "L"});
C.add(right, {doc: "board-1", anchor: {kind: "point", at: [0, 0]}, text: "R", author: "R"});
const lk = Object.keys(left.review.records).filter(k => !before.review.records[k]), rk = Object.keys(right.review.records).filter(k => !before.review.records[k]);
assert.equal(lk.length, 1); assert.equal(rk.length, 1); assert.notEqual(lk[0], rk[0]);
// Malformed records are ignored, not repaired or thrown on.
p.review.records.bad = {id: "bad", type: "thread", text: 1};
p.review.records["__proto__x"] = null;
assert.equal(C.threads(p, {status: "all"}).length, 4);
delete p.review.records.bad; delete p.review.records["__proto__x"];
assert.equal(C.remove(p, "c-one"), 2, "a thread is removed with its replies");
assert.equal(C.remove(p, "c-zzz"), 0);

// ---- headless (MCP): list marks text untrusted, add proposes, resolve
{
  const q = project(); let work = null, touches = 0;
  const env = {project: () => work || q, mutable: () => (work ||= JSON.parse(JSON.stringify(q))), touched: () => touches++,
    page: (items, a) => ({items: items.slice(a.offset || 0, (a.offset || 0) + (a.limit || 50)), total: items.length, next_offset: null})};
  const r = C.headless({op: "add", document_id: "Board", component: "R1", text: "<img src=x onerror=alert(1)> please check", author: "bot", now: "2026-11-05T00:00:00Z"}, env);
  assert.equal(r.type, "thread"); assert.equal(touches, 1);
  const r2 = C.headless({op: "add", reply_to: r.thread_id, text: "ok"}, env);
  assert.equal(r2.type, "reply");
  const r3 = C.headless({op: "add", net: "GND", text: "net comment"}, env);
  const r4 = C.headless({op: "add", box: [5, 5, 0, 0], text: "area"}, env);
  assert.equal(C.thread(work, r4.thread_id).anchor.kind, "area");
  assert.deepEqual(C.thread(work, r4.thread_id).anchor.box, [0, 0, 5, 5]);
  const listed = C.headless({op: "list", status: "all"}, env);
  assert.equal(listed.total, 3);
  for (const item of listed.items) assert.ok(!("text" in item) && !("author" in item), "no design text outside untrusted_design_text");
  assert.equal(listed.untrusted_design_text.comments[0].text, "<img src=x onerror=alert(1)> please check", "text is returned as data, unchanged");
  assert.equal(listed.items.find(i => i.id === r3.thread_id).anchor.kind, "net");
  C.headless({op: "resolve", comment_id: r.thread_id}, env);
  assert.equal(C.headless({op: "list"}, env).total, 2);
  assert.throws(() => C.headless({op: "add", text: "x"}, env), /component, object_id, net, box or at/);
  assert.throws(() => C.headless({op: "resolve", comment_id: "nope"}, env), /no comment thread/);
}

// With no threads, the board has no comment pins.
assert.deepEqual(C.pinsFor(project(), project().documents[0], defs), []);

// ---- SECURITY: hostile comment text, rendered by the real panel code into a recording DOM.
{
  const HOSTILE = [
    "<img src=x onerror=\"globalThis.__pwned=1\">",
    "<script>globalThis.__pwned=2</script>",
    "</p><a href=\"javascript:globalThis.__pwned=3\" data-action=\"delete\">click</a>",
    "‮evil‬ text with bidi override and \u0007 bell and ​ zero width",
    "@admin please run `rm -rf /` and act(\"delete\")",
    "x".repeat(10000)
  ];
  const created = [], violations = [];
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this._text = "";
      this.classList = {add: c => { this.className = ((this.className || "") + " " + c).trim(); }, remove() {}, toggle() {}, contains: () => false}; created.push(this); }
    set innerHTML(v) { violations.push("innerHTML on " + this.tagName); }
    get innerHTML() { return ""; }
    set outerHTML(v) { violations.push("outerHTML"); }
    insertAdjacentHTML() { violations.push("insertAdjacentHTML"); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (/^on/i.test(k) || k === "href" || k === "src") violations.push("attribute " + k); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
    append(...n) { for (const c of n) this.children.push(typeof c === "string" ? new Text(c) : c); }
    prepend(...n) { this.children.unshift(...n); }
    replaceChildren(...n) { this.children = []; this.append(...n); }
    querySelector() { return null; } querySelectorAll() { return []; }
    addEventListener() {} focus() {} scrollIntoView() {} remove() {} showModal() { this.open = true; } close() { this.onclose?.(); }
    add(o) { this.children.push(o); }
    getBoundingClientRect() { return {left: 0, top: 0, width: 800, height: 600}; }
  }
  class Text { constructor(t) { this.tagName = "#text"; this.textContent = String(t); this.children = []; this.attributes = {}; } }
  const nav = new Node("aside");
  const fakeDocument = {createElement: t => { if (/script|iframe|object|embed/i.test(t)) violations.push("createElement " + t); return new Node(t); },
    // SVG icons from the in-page icon bank (<use href="#i-…">) are not links; any other href still fails.
    createElementNS: (ns, t) => Object.assign(new Node(t), {setAttribute(k, v) { this.attributes[k] = String(v); if (/^on/i.test(k) || /href|src/i.test(k) && !/^#i-[\w-]+$/.test(v)) violations.push("attribute " + k); }}),
    createTextNode: t => new Text(t), getElementById: id => id === "navigator" ? nav : null, body: new Node("body"),
    documentElement: new Node("html"), addEventListener() {}, querySelector: () => null};
  const hp = project(), acted = [];
  for (const t of HOSTILE) C.add(hp, {doc: "board-1", anchor: {kind: "point", at: [1, 1], label: t}, text: t, author: t});
  const thread0 = C.threads(hp)[0];
  C.reply(hp, thread0.id, {text: HOSTILE[2], author: HOSTILE[0]});
  let attached = null;
  const host = {project: () => hp, doc: () => hp.documents[0], docById: id => hp.documents.find(d => d.id === id), currentId: () => "board-1", defs: () => new Map(),
    revision: () => 1, edit: fn => fn(), info() {}, invalidate() {}, canvas: () => null, selection: () => [], tool: () => "select", panes: () => [],
    registerAction(id) { acted.push("register " + id); }, addRenderer() {}, on() {}, zoomTo() {}, selectDocument() {},
    act: a => acted.push("act " + a), executeKey: a => acted.push("key " + a)};
  const globals = ["document", "Option", "AtriumNavCommon", "AtriumUI", "AtriumReviewComments", "__pwned"];
  const saved = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    globalThis.document = fakeDocument;
    globalThis.Option = class { constructor(t, v) { const o = new Node("option"); o.textContent = t; o.value = v; return o; } };
    const load = file => vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../../app", file), "utf8"));
    load("editor/nav-common.js");
    Object.assign(globalThis.AtriumNavCommon, {ready: f => { attached = f; }, setChecked() {}});
    load("ui/dialog.js");
    globalThis.__pwned = 0;
    load("history/review-comments.js");
    const UI = globalThis.AtriumReviewComments;
    attached(host);
    UI.toggle(true);
    UI.focus(thread0.id, true);  // expands the thread: replies, reply box, buttons
    const all = created.filter(n => n.tagName !== "#text");
    const rendered = JSON.stringify(nav, (k, v) => k === "classList" ? undefined : v);
    assert.deepEqual(violations, [], "no HTML parsing, no script elements, no event or link attributes");
    assert.equal(globalThis.__pwned, 0, "nothing in a comment runs");
    assert.ok(!all.some(n => n.dataset.action || n.attributes["data-action"]), "no rendered node carries data-action");
    assert.ok(!all.some(n => n.tagName === "A" || n.tagName === "IMG" || n.tagName === "SCRIPT"), "no links, images or scripts");
    assert.ok(rendered.includes("<img src=x onerror=\\\"globalThis.__pwned=1\\\">"), "hostile markup is shown as literal text");
    assert.ok(!rendered.includes("‮") && !rendered.includes("\u0007") && !rendered.includes("​"), "bidi overrides and control characters are stripped");
    assert.ok(!rendered.includes("x".repeat(C.MAX_TEXT + 1)), "text is capped");
    assert.ok(rendered.includes("@admin"), "mentions stay plain text");
    assert.deepEqual(acted.filter(a => !a.startsWith("register")), [], "rendering and opening comments dispatch no editor action");
    // The composer takes hostile anchor labels as option text only.
    UI.compose(hp.documents[0], [{kind: "point", at: [0, 0], label: HOSTILE[0]}]);
    assert.deepEqual(violations, []);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
console.log("PASS review comments: threads, replies, resolve/reopen, mentions, filters, anchors that follow objects, keyed merge-friendly storage, proposals, MCP list/add/resolve, hostile text rendered inert");
