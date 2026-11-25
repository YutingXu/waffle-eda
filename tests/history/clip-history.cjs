"use strict";
// Clipboard history (app/history/clip-history.js) with the real selection clipboard: recording copies
// and cuts, de-duplication, recopy onto the system clipboard, kind checks, pins, rename, delete,
// the size limit and data budget, per-user persistence of pins (and of history when chosen),
// untrusted saved entries, and the memory used by 20 large entries.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {webcrypto} = require("node:crypto");

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m};
}
function editor({local = store(), host} = {}) {
  const listeners = {}, document = {querySelector: () => null, addEventListener: (n, f) => listeners[n] = f};
  const timers = [];
  const env = vm.createContext({document, window: {getSelection: () => ""}, crypto: webcrypto, __waffleUUIDSeed:globalThis.__waffleUUIDSeed, structuredClone, navigator: {}, AtriumHost: host, localStorage: local,
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {}, console});
  for (const name of ["uuid-v7", "model", "theme", "parts", "placement", "paste-plan", "edit-selection", "selection-clipboard", "clip-history"]) vm.runInContext(fs.readFileSync(require("../support/app-source-paths.cjs").appFile(name + ".js"), "utf8"), env);
  const {Atrium: A, AtriumEditSelection: E, AtriumSelectionClipboard: C, AtriumClipHistory: H} = env;
  const project = env.AtriumParts.example(), docs = {sch: project.documents[0], pcb: project.documents[1]};
  let current = docs.pcb, clip = null, rev = 0, ids = new Set();
  const reports = [], placed = [], info = [];
  const defs = () => new Map(project.library.map(d => [d.id, d]));
  const api = C.install({
    capture: cut => E.capture(current, defs(), ids, cut), local: () => clip, context: () => current, revision: () => rev,
    store: (v, cut) => { clip = v; if (cut) { current.items = current.items.filter(i => !ids.has(i.id)); rev++; } },
    place: v => { const plan = E.prepare(project, current, v, defs()); placed.push(plan.items.length); },
    report: t => reports.push(t)
  });
  H.attach({doc: () => current, info: t => info.push(t), registerAction() {}, on() {}});
  return {env, A, C, H, api, project, docs, reports, placed, info, local, flush: () => { while (timers.length) timers.shift()(); },
    select(kind, filter) { current = docs[kind]; ids = new Set(current.items.filter(filter).map(i => i.id)); return ids.size; },
    use(kind) { current = docs[kind]; }, clip: () => clip};
}

async function run() {
  const bus = {packet: null, writes: 0};
  const host = {writeSelection: async p => { bus.packet = p; bus.writes++; return true; }, readSelection: async () => bus.packet};
  const ed = editor({host}), {H} = ed;
  assert.equal(H.list().length, 0, "an empty history");

  // Every copy and cut lands in the history with its kind, source and counts.
  assert.ok(ed.select("pcb", i => i.kind === "part" || i.kind === "track") > 1);
  await ed.api.copy(false);
  let list = H.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "pcb"); assert.equal(list[0].source, ed.docs.pcb.name);
  const parts = ed.docs.pcb.items.filter(i => i.kind === "part").length, tracks = ed.docs.pcb.items.filter(i => i.kind === "track").length;
  assert.equal(list[0].summary, parts + (parts === 1 ? " part" : " parts") + " · " + tracks + (tracks === 1 ? " track" : " tracks"));
  assert.equal(list[0].current, true);
  // The same objects copied again: one entry, moved to the top.
  await ed.api.copy(false);
  assert.equal(H.list().length, 1, "a repeated copy of the same objects is not a new entry");
  ed.select("sch", i => i.kind === "part" || i.kind === "wire");
  await ed.api.copy(false);
  list = H.list();
  assert.equal(list.length, 2); assert.equal(list[0].kind, "schematic"); assert.ok(list[0].current && !list[1].current);
  assert.match(list[0].summary, /parts? · \d+ wires?/);
  assert.ok(/^[A-Z]+\d/.test(list[0].name), "parts give a designator name: " + list[0].name);

  // Recopy: the older board entry becomes the editor's clipboard and the system clipboard again.
  const board = list[1].id, writes = bus.writes;
  assert.equal(await H.recopy(board), true);
  assert.equal(ed.clip().kind, "pcb"); assert.equal(bus.writes, writes + 1); assert.equal(JSON.parse(bus.packet.data).kind, "pcb");
  assert.equal(H.current(), board); assert.equal(H.list().length, 2, "recopy does not add an entry");
  assert.match(ed.info.at(-1), /^Copied “.+” \(.+\) to the clipboard\.$/);
  // Paste of a board entry into a schematic: a clear message, no paste.
  ed.use("sch");
  assert.equal(await H.recopy(board, {paste: true}), false);
  assert.equal(ed.placed.length, 0); assert.match(ed.info.at(-1), /layout \(PCB\) objects: open a PCB layout to paste it/);
  ed.use("pcb");
  const clipboard = ed.C.active(), place = clipboard.place;
  let ready;
  clipboard.place = clip => new Promise(resolve => { ready = () => { place(clip); resolve(); }; });
  const pasting = H.recopy(board, {paste: true});
  assert.equal(await Promise.race([pasting, Promise.resolve("pending")]), "pending", "recopy waits for cold placement");
  ready();
  assert.equal(await pasting, true);
  clipboard.place = place;
  assert.equal(ed.placed.length, 1, "Enter / double-click starts the paste");
  // A schematic entry on a board points at Update PCB.
  assert.equal(await H.recopy(H.list()[0].id, {paste: true}), false);
  assert.match(ed.info.at(-1), /schematic objects: open a schematic sheet.*Update PCB/);

  // Without a system clipboard the recopy still lands inside Waffle and says so.
  const offline = editor(); offline.env.navigator.clipboard = {writeText: async () => { throw Error("Denied"); }};
  offline.select("pcb", i => i.kind === "via" || i.kind === "track");
  await offline.api.copy(false);
  offline.select("pcb", i => i.kind === "part");
  await offline.api.copy(false);
  const first = offline.H.list()[1];
  assert.equal(await offline.H.recopy(first.id), true);
  assert.equal(offline.clip().items.length, first.counts.track + (first.counts.via || 0));
  assert.match(offline.info.at(-1), /inside Waffle; the system clipboard is unavailable\.$/);

  // Pin, rename (control characters and length capped), delete.
  const sch = H.list()[0].id;
  assert.equal(H.pin(sch).pinned, true);
  assert.equal(H.rename(sch, "Power\nstage\u0007 " + "x".repeat(200)).name.length, 80);
  assert.ok(!/[\n\u0007]/.test(H.list()[0].name));
  assert.equal(H.rename(sch, "  ").custom, false, "an empty name returns to the automatic one");
  H.rename(sch, "Power stage");
  assert.equal(H.remove(board), true); assert.equal(H.list().length, 1);

  // Pins persist per user; unpinned history only with the preference.
  ed.flush();
  let saved = JSON.parse(ed.local.getItem(H.STORE));
  assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].name, "Power stage"); assert.equal(saved.entries[0].pinned, true);
  assert.equal(ed.local.getItem("atrium.prefs"), null, "nothing goes into preferences or the project");
  assert.ok(!JSON.stringify(ed.project).includes("Power stage"), "the project file never holds the history");
  const later = editor({local: store({[H.STORE]: ed.local.getItem(H.STORE)})});
  assert.equal(later.H.restore(), 1);
  assert.equal(later.H.list()[0].name, "Power stage"); assert.equal(later.H.list()[0].pinned, true);
  assert.equal(await later.H.recopy(later.H.list()[0].id), true, "a restored pin recopies");
  assert.equal(later.clip().kind, "schematic");

  // History across restarts (preference on), and the size limit (preference) with pins exempt.
  const keepPrefs = store({"atrium.prefs": JSON.stringify({format: "atrium-prefs", version: 1, values: {"clipboard.keepHistory": true, "clipboard.historySize": 3}})});
  const big = editor({local: keepPrefs});
  const kinds = ["part", "track", "via", "pad", "label"];
  for (const k of kinds) { assert.ok(big.select("pcb", i => i.kind === k)); await big.api.copy(false); }
  assert.equal(big.H.list().filter(e => !e.pinned).length <= 3, true, "at most clipboard.historySize unpinned entries");
  big.H.pin(big.H.list().at(-1).id);
  for (const k of ["track", "via"]) { big.select("pcb", i => i.kind === k || i.kind === "pad"); await big.api.copy(false); }
  assert.equal(big.H.list().filter(e => e.pinned).length, 1, "pins survive trimming");
  assert.equal(big.H.list().filter(e => !e.pinned).length, 3);
  big.flush();
  saved = JSON.parse(keepPrefs.getItem(big.H.STORE));
  assert.equal(saved.entries.length, 4, "with keepHistory the unpinned history is saved too");
  const back = editor({local: store({[big.H.STORE]: keepPrefs.getItem(big.H.STORE), "atrium.prefs": keepPrefs.getItem("atrium.prefs")})});
  assert.equal(back.H.restore(), 4);
  const noKeep = editor({local: store({[big.H.STORE]: keepPrefs.getItem(big.H.STORE)})});
  assert.equal(noKeep.H.restore(), 1, "without the preference only pins come back");

  // Saved entries are untrusted: bad shapes are dropped, text is cleaned, a tampered copy is refused on use.
  const good = saved.entries[0];
  const hostile = [
    null, 7, [], {...good, id: "<img src=x onerror=alert(1)>"}, {...good, kind: "html"}, {...good, data: "<script>"}, {...good, data: 5},
    {...good, id: "ok-name", pinned: true, name: "<b>bold</b>\u0000", source: "s".repeat(500), counts: {part: 3, "<x>": 4, track: -1, via: 1.5}},
    {...good, id: "tampered", pinned: true, data: good.data.replace('"items":[', '"items":[{"kind":"script","id":"x"},')}
  ];
  const evil = editor({local: store({[H.STORE]: JSON.stringify({format: "atrium-clip-history", version: 1, entries: hostile})})});
  assert.equal(evil.H.restore(), 2);
  const named = evil.H.list().find(e => e.id === "ok-name");
  assert.equal(named.name, "<b>bold</b> ", "names stay text (rendered with textContent), control characters removed");
  assert.equal(named.source.length, 120); assert.equal(JSON.stringify(named.counts), JSON.stringify({part: 3}));
  assert.equal(await evil.H.recopy("tampered"), false, "a tampered entry is not adopted");
  assert.equal(evil.H.list().some(e => e.id === "tampered"), false, "and it is removed");
  assert.equal(evil.clip(), null);
  for (const bad of ["{", JSON.stringify({format: "x"}), JSON.stringify({format: "atrium-clip-history", version: 2, entries: [good]})])
    assert.equal(editor({local: store({[H.STORE]: bad})}).H.restore(), 0);

  // Pours (polygons), power ports and buses now survive the clipboard's validator.
  const C = ed.C;
  const poly = {format: "atrium-selection", version: 1, token: "t", kind: "pcb", origin: [0, 0], library: [],
    items: [{id: "p1", kind: "polygon", layer: "Top", net: "GND", points: [[0, 0], [5, 0], [5, 5]], closed: true}]};
  assert.equal(C.decode(JSON.stringify(poly)).items[0].kind, "polygon");

  // Memory: 20 large entries (a 2,000-track board selection each, all distinct).
  const mem = editor();
  const pcb = mem.docs.pcb, base = pcb.items.find(i => i.kind === "track");
  for (let n = 0; n < 20; n++) {
    const extra = [];
    for (let k = 0; k < 2000; k++) extra.push({...base, id: "m" + n + "-" + k, points: [[k * .5, n], [k * .5 + .4, n + 1]]});
    pcb.items.push(...extra);
    mem.select("pcb", i => i.id.startsWith("m" + n + "-"));
    await mem.api.copy(false);
  }
  const s = mem.H.stats();
  assert.equal(s.entries, 20);
  assert.ok(s.dataBytes < s.budget, "20 large entries fit the data budget");
  const each = s.dataBytes / s.entries;
  console.log("memory: 20 entries x 2,000 tracks: data " + (s.dataBytes / 1048576).toFixed(2) + " MiB (" + (each / 1024).toFixed(0) + " KiB each), stored once; budget " + (s.budget / 1048576) + " MiB");
  // The data budget trims the oldest unpinned entries but keeps the newest.
  let huge = null;
  for (const c of "abc") huge = mem.H.record({data: '{"format":"atrium-selection","version":1,"token":"z","kind":"pcb",' + '"pad":"' + c.repeat(15 * 1048576) + '"}', kind: "pcb", items: []});
  assert.ok(huge);
  assert.ok(mem.H.list().length < 23, "older entries were trimmed for the budget");
  assert.ok(mem.H.stats().dataBytes <= s.budget, "the budget holds");
  assert.equal(mem.H.list()[0].id, huge.id);
  assert.equal(mem.H.record({data: "x".repeat(mem.H.limits.entryMax + 1), kind: "pcb"}), null, "copies over the clipboard limit are not kept");
  // Pins are never trimmed, so they have their own ceiling: the data budget.
  const pins = [];
  for (const c of "defg") { const e = mem.H.record({data: '{"format":"atrium-selection","version":1,"token":"z","kind":"pcb",' + '"pad":"' + c.repeat(15 * 1048576) + '"}', kind: "pcb", items: []}); pins.push(mem.H.pin(e.id, true)); }
  assert.deepEqual(pins.map(p => p.pinned), [true, true, true, false], "the fourth 15 MB pin would pass the budget");
  assert.ok(mem.H.stats().dataBytes <= s.budget + mem.H.limits.entryMax, "pins stay inside the budget (plus the newest copy, always kept)");
  assert.equal(mem.H.pin(pins[0].id, false).pinned, false, "unpinning is always allowed");
  assert.equal(mem.H.pin(pins[3].id, true)?.pinned ?? true, true, "and frees room for another pin");
  console.log("PASS clipboard history records, de-duplicates, recopies (system and in-app), checks kinds, pins, renames, deletes, trims to its limit and budget, persists pins per user and refuses untrusted saved entries.");
}
// The JSC shim waits for __testDone and fails on its rejection; Node sets the exit code.
globalThis.__testDone = run();
globalThis.__testDone.catch(error => { console.error(error); process.exitCode = 1; });
