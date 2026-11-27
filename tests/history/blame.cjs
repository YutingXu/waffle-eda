"use strict";
// Semantic blame (app/history/blame.js engine): the per-object history walk over zero-context patches.
// Versions are written with the editor's serializer (one object per line); the hunks are what
// `git log -p -U0` reports (computed here by a small line diff). Checks: last change per part,
// track and net, added objects, comma-only neighbours, document fields, re-formatted objects,
// minified files, field rows, and the speed of 200 commits of the 25.6k-object board.
const assert = require("node:assert/strict"), path = require("node:path");
for (const name of ["model", "parts", "eco", "blame", "import-reports"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const E = globalThis.AtriumBlame.engine;
const clone = v => JSON.parse(JSON.stringify(v));

// Zero-context hunks old -> new: common prefix/suffix, then a greedy line match in between.
function hunks(oldText, newText) {
  const a = oldText.split("\n"), b = newText.split("\n"), out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    // Find the next line both share after this point (small windows: edits are local).
    let ni = -1, nj = -1;
    search: for (let span = 1; span < 4000; span++) for (let di = 0; di <= span; di++) {
      const dj = span - di;
      if (i + di <= a.length && j + dj <= b.length && (i + di === a.length && j + dj === b.length || a[i + di] !== undefined && a[i + di] === b[j + dj])) { ni = i + di; nj = j + dj; break search; }
    }
    if (ni < 0) { ni = a.length; nj = b.length; }
    const rem = a.slice(i, ni), add = b.slice(j, nj);
    out.push([rem.length ? i + 1 : i, rem.length, add.length ? j + 1 : j, add.length, rem, add]);
    i = ni; j = nj;
  }
  return out;
}
function history(versions) {
  // versions oldest first -> commits newest first, as blameLog returns them
  const commits = versions.map((v, k) => ({revision: String(k).padStart(40, "0"), author: "A" + k, date: "2026-01-0" + (k % 9 + 1) + "T00:00:00Z",
    subject: "v" + k, oldBlob: k ? "b" + (k - 1) : null, blob: "b" + k, parents: k ? [String(k - 1).padStart(40, "0")] : []})).reverse();
  const patches = new Map();
  for (let k = 1; k < versions.length; k++) patches.set(commits[versions.length - 1 - k].revision, hunks(versions[k - 1], versions[k]));
  const w = new E.Walk(commits, versions.at(-1));
  while (!w.done) { const c = commits[w.next]; w.step(c.oldBlob ? patches.get(c.revision) : null); }
  return {w, commits, subject: i => commits[i].subject};
}

async function liveKiCadHistory() {
  const source = "Board.kicad_pcb", part = {id: "part", kind: "part", ref: "R5", value: "10k", pinNets: {1: "GND"}};
  const copy = {...part, id: "copy", ref: "R1", kicadSourceId: "original-part"};
  const track = {id: "track", kind: "track", net: "GND", width: .25};
  const board = {id: "pcb", kind: "pcb", items: [part, copy, track]};
  const otherBoard = {id: "other", kind: "pcb", items: [{...part, id: "other-part"}]};
  const sheet = {id: "current-sheet", kind: "schematic", items: []};
  const project = {documents: [board, otherBoard, sheet], library: []};
  const rows = [
    {type: "item", id: part.id, values: {kicadSourceId: "original-part"}},
    {type: "item", id: track.id, values: {kicadSourceId: "original-track"}},
    {type: "item", id: "other-part", values: {kicadSourceId: "original-part"}}
  ];
  const files = [{name: source, documents: [board.id]}, {name: "Other.kicad_pcb", documents: [otherBoard.id]}];
  const revision = (value, width) => ({documents: [{id: "revision", kind: "pcb", items: [
    {...part, id: "old-part", value, kicadSourceId: "original-part"}, {...track, id: "old-track", width, kicadSourceId: "original-track"}
  ]}], library: []});
  const revisions = {a: revision("22k", .2), b: revision("10k", .25)};
  let reads = 0, session = {};
  const host = {project: () => project, doc: () => sheet, fileSession: () => session, on() {}, registerAction() {}, edit: fn => fn()};
  AtriumImportReports.attach(host);
  function remember(fields = rows, inputs = files) {
    return AtriumImportReports.remember(session, {report: {translator: "kicad"}, provenance: {files: inputs, fields}},
      [board.id, otherBoard.id], inputs.map(file => file.name));
  }
  function open(fields, inputs) {
    session = {};
    session.imported = {id: remember(fields, inputs).scopeId};
  }
  const reader = {
    async page(skip, limit, visit) {
      reads++;
      await visit({revision: "b", parents: ["a"], subject: "Edit design"}, "a", "b");
      await visit({revision: "a", parents: [], subject: "First design"}, null, "a");
      return {checked: 2, head: "b"};
    },
    async project(id) { return revisions[id]; }
  };
  globalThis.AtriumHost = {historyPath: source};
  const history = (item, doc = board) => AtriumBlame.sourceHistory(reader, host, {docId: doc.id, item}, true);
  async function unresolved(item, doc) {
    const before = reads;
    await assert.rejects(history(item, doc), /no unique source identifier/);
    assert.equal(reads, before, "a target without proven ownership must not query Git");
  }
  open();
  const saved = JSON.stringify(project);
  for (const [item, field, before, after] of [[part, "Value", "22k", "10k"], [track, "Width", "0.2", "0.25"]]) {
    const result = await history(item);
    assert.deepEqual(result.working, []);
    assert.deepEqual(result.entries.map(entry => entry.commit.subject), ["Edit design", "First design"]);
    assert.deepEqual(result.entries[0].fields, [{field, before, after}]);
  }
  assert.equal(JSON.stringify(project), saved, "history must leave the live model untouched");
  await unresolved(copy);
  await unresolved(otherBoard.items[0], otherBoard);
  await unresolved({...part, id: "missing"});
  // A later report in the same session is never authority for the file that opened it.
  remember([{type: "item", id: copy.id, values: {kicadSourceId: "original-part"}}]);
  await unresolved(copy);
  AtriumImportReports.discard(session.imported.id);
  await unresolved(part);
  await unresolved(copy);
  // Duplicate live source owners, duplicate rows for the selected owner and uncertain files.
  open([...rows, {type: "item", id: copy.id, values: {kicadSourceId: "original-part"}}]);
  await unresolved(part);
  open([...rows, rows[0]]);
  await unresolved(part);
  open(rows, [...files, {...files[0]}]);
  await unresolved(part);
  // The older inline representation still uses source identity when no retained scope exists.
  session = {};
  delete copy.kicadSourceId;
  part.kicadSourceId = "original-part";
  assert.deepEqual((await history(part)).entries.map(entry => entry.status), ["modified", "added"]);
  const result = await AtriumBlame.sourceHistory(reader, host, {net: "GND"}, true);
  assert.deepEqual(result.entries.map(entry => entry.objects.length), [2, 2]);
  revisions.b.documents[0].items[0].pinNets = {1:"VCC"};
  const moved = await AtriumBlame.sourceHistory(reader, host, {net:"GND"}, true);
  assert.deepEqual(moved.entries[0].objects.map(row=>row.label), ["R5 left","track"]);
  delete globalThis.AtriumHost;
  console.log("PASS live KiCad part and track history with scoped provenance, rejected copies and duplicates, legacy items and net history");
}

function run() {
  // Reimporting a KiCad board regenerates the editor's IDs. Only source identities prove lineage.
  {
    const board = (suffix, x) => ({library: [{id: "lib" + suffix, name: "Connector", footprint: {name: "USB"}}],
      documents: [{id: "board" + suffix, kind: "pcb", items: [{id: "local" + suffix, kicadSourceId: "abcd1234", kind: "part",
        def: "lib" + suffix, link: "local-link" + suffix, ref: "J1", pinNets: {1: "USB"}, x}]}]});
    const a = board("A", 12), b = board("B", 12), target = {item: a.documents[0].items[0]};
    const get = (p, t = target) => E.sourceValue(p, t, true, "pcb");
    assert.deepEqual(E.fields(get(a), get(b)), []);
    assert.deepEqual([...get(a, {net: "USB"})], [...get(b, {net: "USB"})]);
    b.documents[0].items[0].x = 15;
    assert.deepEqual(E.fields(get(a), get(b)), [{field: "X", before: "12", after: "15"}]);
    b.documents[0].items.push({...b.documents[0].items[0], id: "another-local-id"});
    assert.throws(() => get(b), /ambiguous/);
    assert.throws(() => get(b, {net: "USB"}), /ambiguous/);
    b.documents[0].items.pop();
    delete b.documents[0].items[0].kicadSourceId;
    assert.throws(() => get(b), /ambiguous/);
    assert.throws(() => get(b, {net: "USB"}), /ambiguous/);
  }
  const S = AtriumECO.serialize, p = AtriumParts.example(), pcb = p.documents.find(d => d.kind === "pcb");
  const parts = pcb.items.filter(i => i.kind === "part"), track = pcb.items.find(i => i.kind === "track" && i.net);
  const key = i => E.itemKey(pcb.id, i.id);
  const v = [S(p)];
  parts[0].x += 1; v.push(S(p));                                   // v1 moves part 0
  parts[1].value = "47k"; v.push(S(p));                            // v2 edits part 1
  pcb.items.push({id: "new-via", kind: "via", x: 1, y: 2, diameter: .6, drill: .3, layer: "Multi"}); v.push(S(p)); // v3 adds a via (last line: comma on the neighbour)
  pcb.name = "Main board"; v.push(S(p));                            // v4 document field
  track.width = 0.4; v.push(S(p));                                  // v5 track
  const {w, subject} = history(v);
  assert.ok(w.done);
  assert.equal(subject(w.last(key(parts[0])).i), "v1");
  assert.equal(subject(w.last(key(parts[1])).i), "v2");
  assert.equal(subject(w.last(key(track)).i), "v5");
  assert.equal(subject(w.last(E.itemKey(pcb.id, "new-via")).i), "v3");
  assert.equal(w.last(E.itemKey(pcb.id, "new-via")).status, "added");
  assert.equal(w.last(key(parts[2])).status, "created", "untouched objects date from the first commit");
  const before = pcb.items[pcb.items.length - 2];
  assert.equal(w.last(key(before)).status, "created", "the neighbour that only gained a comma did not change");
  assert.equal(subject(w.last("documents/" + pcb.id).i), "v4", "document fields");
  const h = E.history(w, {key: key(parts[1])});
  assert.equal(h[0].status, "modified");
  assert.deepEqual(h[0].fields, [{field: "Value", before: AtriumParts.example().documents.find(d => d.kind === "pcb").items.find(i => i.id === parts[1].id).value, after: "47k"}]);
  assert.equal(h.at(-1).status, "created");
  const net = E.history(w, {net: track.net});
  const onNet = i => E.netsOf(i).has(track.net);
  const expected = ["v5", onNet(parts[1]) && "v2", onNet(parts[0]) && "v1"].filter(Boolean);
  assert.deepEqual(net.map(e => e.commit.subject), expected, "net history: the commits that changed objects on the net");

  // An object re-written with the same content in another key order is not a change.
  {
    const q = AtriumParts.example(), b = q.documents.find(d => d.kind === "pcb"), t1 = S(q);
    const lines = t1.split("\n"), at = lines.findIndex(l => l.includes('"id":"' + b.items[0].id + '"'));
    const obj = JSON.parse(lines[at].trim().replace(/,$/, ""));
    const shuffled = "{" + Object.keys(obj).reverse().map(k => JSON.stringify(k) + ":" + JSON.stringify(obj[k])).join(",") + "}";
    lines[at] = lines[at].replace(/\{.*\}/, shuffled);
    const r = history([t1, lines.join("\n")]);
    assert.ok(r.w.records.has(E.itemKey(b.id, b.items[0].id)), "the text changed");
    assert.equal(E.history(r.w, {key: E.itemKey(b.id, b.items[0].id)}).filter(e => e.status === "modified").length, 0, "but not the object");
    assert.equal(r.w.last(E.itemKey(b.id, b.items[0].id)).status, "created", "Properties and the history list agree on a formatting-only commit");
  }
  // A minified file (one line) falls back to comparing parsed versions.
  {
    const q = AtriumParts.example(), b = q.documents.find(d => d.kind === "pcb"), m0 = JSON.stringify(q);
    b.items[0].x += 2; const m1 = JSON.stringify(q);
    const r = history([m0, m1]);
    assert.equal(r.w.last(E.itemKey(b.id, b.items[0].id)).status, "modified");
    assert.equal(r.w.last(E.itemKey(b.id, b.items[1].id)).status, "created");
  }
  // Older layout: every key on its own line (JSON.stringify(sorted, null, 2)).
  {
    const pretty = x => { const s = o => Array.isArray(o) ? o.map(s) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map(k => [k, s(o[k])])) : o; return JSON.stringify(s(x), null, 2) + "\n"; };
    const q = AtriumParts.example(), b = q.documents.find(d => d.kind === "pcb"), t0 = pretty(q);
    const y = b.items[3].y;
    b.items[3].y += 1; const r = history([t0, pretty(q)]);
    assert.equal(r.w.last(E.itemKey(b.id, b.items[3].id)).status, "modified");
    assert.deepEqual(E.history(r.w, {key: E.itemKey(b.id, b.items[3].id)})[0].fields,
      [{field: "Y", before: String(y), after: String(y + 1)}], "an expanded field hunk retains its full before and after object");
    assert.equal(r.w.last(E.itemKey(b.id, b.items[2].id)).status, "created");
  }
  // New fields and a newly added sheet in JSON formatted by external tools.
  for (const space of [2, 4, "\t"]) {
    const layout = x => JSON.stringify(x, null, space) + "\n";
    const q = {documents: [{id: "d", items: [{id: "p", kind: "part"}]}]}, a = layout(q);
    q.documents[0].items[0].value = "47k";
    const b = layout(q);
    q.documents.push({id: "sheet", items: [{id: "new-part", kind: "part", value: "1u"}]});
    const r = history([a, b, layout(q)]);
    assert.equal(r.w.last(E.itemKey("sheet", "new-part")).status, "added");
    const edit = E.history(r.w, {key: E.itemKey("d", "p")})[0];
    assert.equal(edit.status, "modified");
    assert.deepEqual(edit.fields, [{field: "Value", before: "—", after: "47k"}]);
  }
  // 200 commits of the 25.6k-object board.
  {
    require("../pcb/dense-board.js");
    const {d} = makeAtriumBenchmarkBoard(160);
    d.id = "pcb-perf";
    const big = Atrium.project("Dense", AtriumParts.catalogue); big.documents = [d];
    const bp = d.items.filter(i => i.kind === "part");
    let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const versions = [S(big)], commits = [], patches = new Map();
    let text = versions[0];
    const t0 = Date.now();
    for (let k = 1; k < 200; k++) {
      const moved = [];
      for (let m = 0, n = [1, 2, 3, 5, 40][rnd(5)]; m < n; m++) { const part = bp[rnd(bp.length)]; part.x = +(part.x + 0.1).toFixed(3); moved.push(part); }
      // Patches are built from the changed lines directly (each object is one line).
      const lines = text.split("\n"), hk = [];
      const next = lines.slice();
      for (const part of [...new Set(moved)]) {
        const at = next.findIndex(l => l.includes('"id":"' + part.id + '"'));
        const updated = next[at].replace(/"x":[-0-9.e]+/, '"x":' + part.x);
        hk.push([at + 1, 1, at + 1, 1, [next[at]], [updated]]); next[at] = updated;
      }
      hk.sort((a, b) => a[2] - b[2]);
      text = next.join("\n");
      commits.unshift({revision: String(k).padStart(40, "0"), oldBlob: "b" + (k - 1), blob: "b" + k, subject: "c" + k, author: "P", date: "2026-01-01T00:00:00Z"});
      patches.set(commits[0].revision, hk);
    }
    commits.push({revision: "0".repeat(40), oldBlob: null, blob: "b0", subject: "c0"});
    const build = Date.now() - t0;
    const t1 = Date.now(), w = new E.Walk(commits, text);
    while (!w.done) { const c = commits[w.next]; w.step(c.oldBlob ? patches.get(c.revision) : null); }
    const ms = Date.now() - t1;
    const changed = [...w.records.keys()].length;
    console.log("blame: 25.6k board, 200 commits walked in " + ms + " ms (" + changed + " objects changed; history built in " + build + " ms)");
    assert.ok(ms < 3000, "walk under 3 s");
    const one = bp.find(x => w.records.has(E.itemKey(d.id, x.id)));
    assert.ok(E.history(w, {key: E.itemKey(d.id, one.id)}).every(e => e.status !== "modified" || e.fields.some(f => f.field === "X")));
  }
  console.log("PASS semantic blame: last change per part, track, net and document field, added objects, comma-only neighbours, re-ordered keys, minified and older layouts, 200 commits of the 25.6k board.");
}
// The Properties history control: a library button (small, quiet, history icon), shown only for a
// project whose file Git tracks. Opening any Altium or KiCad file binds it for history, so the
// inspector asks the repository once per binding and leaves the control out when there is no history.
async function inspectorControl() {
  const G = globalThis, saved = {host: G.AtriumHost, common: G.AtriumNavCommon, ui: G.AtriumUI};
  const node = (tag, cls) => ({tag, className: cls || "", hidden: false, dataset: {}, attrs: {}, kids: [], textContent: "", isConnected: true,
    append(...k) { this.kids.push(...k); }, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.isConnected = false; },
    get text() { return this.textContent + this.kids.map(k => k.text ?? "").join(""); }});
  G.AtriumNavCommon = {el: (tag, text, cls) => { const n = node(tag, cls); if (text != null) n.textContent = text; return n; }, icon: name => ({tag: "svg", icon: name, text: ""})};
  G.AtriumUI = {nativeButton: (text, act, cls, title, o) => { const n = node("button", "ui-button " + cls); n.dataset.variant = o.variant; n.dataset.size = o.size; return n; }};
  const panel = {kids: [], querySelector: () => null, append(n) { this.kids.push(n); }};
  const host = {doc: () => ({id: "board"})}, item = {id: "r1", kind: "part", ref: "R1"};
  let asked = 0;
  try {
    for (const [generation, commits, shown] of [[1, [{revision: "a"}], true], [2, [], false]]) {
      G.AtriumHost = {historyPath: "Board.PrjPcb", projectGeneration: generation, historyQuery: async op => { asked++; assert.equal(op, "sourceLog"); return {commits}; }};
      panel.kids = [];
      G.AtriumBlame.inspector(panel, host, item);
      const line = panel.kids[0];
      assert.ok(line && line.hidden, "the line waits for the repository answer");
      await new Promise(r => setTimeout(r, 0));
      assert.equal(line.isConnected && !line.hidden, shown, "shown only in a Git repository with history");
      const button = line.kids[0];
      assert.equal(button.dataset.variant, "quiet"); assert.equal(button.dataset.size, "sm");
      assert.ok(/\bui-button\b/.test(button.className) && button.kids.some(k => k.icon === "history"), "library button with the history icon");
      assert.equal(button.text, "Show history");
      // The answer is remembered for the binding: the next selection asks nothing and draws at once (or not at all).
      const before = asked; panel.kids = [];
      G.AtriumBlame.inspector(panel, host, item);
      assert.equal(asked, before);
      assert.equal(panel.kids.length, shown ? 1 : 0);
      if (shown) assert.equal(panel.kids[0].hidden, false);
    }
    // A no is trusted for a while only: the file's first commit shows the control a selection later.
    const now = Date.now;
    let commits = [], fail = false, clock = now();
    Date.now = () => clock;
    G.AtriumHost = {historyPath: "Board.PrjPcb", projectGeneration: 3, historyQuery: async () => { asked++; if (fail) throw new Error("git busy"); return {commits}; }};
    const select = async () => { panel.kids = []; G.AtriumBlame.inspector(panel, host, item); await new Promise(r => setTimeout(r, 0)); return !!panel.kids[0]?.isConnected && !panel.kids[0].hidden; };
    try {
      assert.equal(await select(), false, "no commit has the file yet");
      commits = [{revision: "b"}];
      let before = asked;
      assert.equal(await select(), false, "a selection soon after asks nothing");
      assert.equal(asked, before);
      clock += 16000;
      assert.equal(await select(), true, "after the first commit, a later selection shows the control");
      // A failed read is not remembered: the next selection asks again.
      G.AtriumHost = {...G.AtriumHost, projectGeneration: 4};
      fail = true;
      assert.equal(await select(), false, "a failed read shows nothing");
      fail = false; before = asked;
      assert.equal(await select(), true, "the next selection asks again");
      assert.equal(asked, before + 1);
    } finally { Date.now = now; }
    console.log("PASS the Properties history control is a library button shown only for a project in Git.");
  } finally { G.AtriumHost = saved.host; G.AtriumNavCommon = saved.common; G.AtriumUI = saved.ui; }
}
globalThis.__testDone = Promise.resolve().then(run).then(liveKiCadHistory).then(inspectorControl);
globalThis.__testDone.catch(error => { console.error(error); process.exitCode = 1; });
