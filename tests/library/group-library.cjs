"use strict";
const assert = require("node:assert/strict");
for (const file of ["model", "net-intent", "net-intent-index", "signals", "library-store", "library-panel", "library-diff", "group-library", "group-library-sync"])
  require(require("../support/app-source-paths.cjs").appFile(file + ".js"));
const Core = AtriumGroupLibrary, A = Atrium, Lib = AtriumLibrary;
const info = {id: "group-test", name: "Bench library"};
// Standalone JavaScriptCore has no Web Crypto. Its mock remembers exactly what was signed;
// Node and the browser exercise the same workflow with real non-exportable P-256 keys.
if (!globalThis.crypto?.subtle) {
  const signed = new Map(); let next = 0;
  const data = (size, first, id) => { const result = new Uint8Array(size); result[0] = first; result[1] = id; return result; };
  globalThis.crypto = {subtle: {
    generateKey() { const id = ++next; return {privateKey: {id}, publicKey: {id}}; },
    exportKey(_, key) { return data(65, 4, key.id); },
    importKey(_, raw) { return {id: raw[1]}; },
    sign(_, key, msg) { const sig = data(64, ++next, key.id); signed.set(sig.toString(), [key.id, msg.toString()]); return sig; },
    verify(_, key, sig, msg) { const entry = signed.get(sig.toString()); return entry?.[0] === key.id && entry[1] === msg.toString(); }
  }};
}
const credit = {credit: "Synthetic contributors", licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
  sourceUrl: "https://example.invalid/library", licenceUrl: "https://example.invalid/licence", modified: true, licenceText: "Synthetic upstream notice"};
const component = {id: "osc", name: "Synthetic oscillator", prefix: "U", state: "draft",
  source: {kind: "kicad-symbol", entry: "Synthetic:OSC", attribution: credit, footprint: {kind: "kicad-footprint", attribution: credit}},
  model3d: {file: "/fixture/authoring/test.step", stepText: "synthetic model"}, parameters: {Value: "1", password: "omitted"},
  symbol: {shapes: [], pins: [{number: "1", name: "A", x: 0, y: 0}]}};
const propose = (g, def, parent, who, note) => g.propose(def, {author: who, parents: parent ? [parent.key] : [], note});
const approve = (g, r, who, choice) => g.decide({...g.preview(r.key), confirmedIdentities: true}, "approved", who, choice);
async function namingConventions(blue, gold) {
  const X = AtriumNetIntentIndex, a = Core.create(info), b = Core.create(info);
  const p = A.project("Private fixture title", []);
  const sheet = p.documents[0];
  for (const [i, value] of ["1V8", "2V5", "3V3", "4V2", "5V"].entries()) {
    sheet.items.push({id: "l" + i, kind: "power", text: value, x: 10 + i * 5, y: 10});
  }
  X.setConventions(p, c => Object.assign(c, {stems: {rail: ["TEAM_AUX"], clock: ["TEAM_REFCLK"]}, rs485: "B", tally: {"diff:A/B": [2, 1]}}));
  const proposal = X.groupProposal(p);
  assert.equal(proposal.keep.rail.id, "3V3 · 5V", "a sufficiently learned style is portable without exporting example nets");
  assert.deepEqual(Object.keys(proposal).sort(), ["keep", "rs485", "stems"]);
  const first = await a.proposeConventions(proposal, {author: blue, note: "Bench naming"});
  assert.equal(a.library().naming, undefined);
  await approve(a, first, blue);
  const exported = Core.archive(a);
  const git = Core.gitFiles(a).map(f => ({name: f.name, text: async () => f.data}));
  const [gitCopy] = await Core.readGit(git);
  const fromBundle = await Core.readArchive(exported);
  assert.equal(fromBundle.library().naming, undefined, "a bundle's signed approval does not install the revision locally");
  assert.deepEqual(gitCopy.pending()[0].conventions, proposal);
  assert.deepEqual(fromBundle.pending()[0].conventions, proposal);
  assert.ok(!JSON.stringify(exported).includes(p.name), "project metadata stays out of group records");
  const tampered = {...first, conventions: {...first.conventions, rs485: "A"}};
  await assert.rejects(() => b.receive([tampered]), /checksum/);
  const {signature, key, ...body} = first;
  const unsigned = {...body, author: {id: "legacy", name: "Earlier contributor"}};
  unsigned.key = AtriumLibraryStore.sha256(AtriumLibraryStore.canonical(unsigned));
  await assert.rejects(() => b.receive([unsigned]), /member signature/);
  await b.receive(exported.events);
  await assert.rejects(() => b.decide(b.preview(first.key), "approved", gold), /author identity/);
  const q = A.project("Consumer", []);
  globalThis.AtriumGroupLocal = {libraries: () => [b.library()]};
  assert.throws(() => X.useGroupConventions(q, info.id), /Approve naming conventions/);
  await approve(b, first, gold);
  const read = n => X.classify(n, X.conventions(q).effective).role;
  assert.equal(read("TEAM_AUX"), "signal", "approval leaves the second project's option off");
  X.useGroupConventions(q, info.id);
  assert.equal(read("TEAM_AUX"), "rail");
  assert.equal(X.conventions(q).effective.rs485, "B");
  assert.equal(X.complete(q, "2.7", {kind: "power"})[0].name, "2V7");
  X.conventionEdits.set(q, "rs485", "A");
  assert.equal(X.conventions(q).effective.rs485, "A", "explicit project choices take precedence");
  assert.equal(X.exportConventions(q).conventions.group, undefined);
  assert.equal(X.groupProposal(q).stems, undefined, "an adopted group's words are not republished automatically");
  const update = await a.proposeConventions({stems: {rail: ["TEAM_BIAS"]}}, {parents: [first.key], author: blue, note: "New naming"});
  await b.receive([update]); await approve(b, update, gold);
  assert.equal(read("TEAM_AUX"), "rail", "the project's explicit opt-in keeps its approved revision");
  X.useGroupConventions(q, info.id);
  assert.equal(read("TEAM_AUX"), "signal"); assert.equal(read("TEAM_BIAS"), "rail");
  X.useGroupConventions(q, null);
  assert.equal(read("TEAM_BIAS"), "signal");
  const left = await a.proposeConventions({stems: {rail: ["TEAM_LEFT"]}}, {parents: [update.key], author: blue, note: "Left choice"});
  const right = await b.proposeConventions({stems: {rail: ["TEAM_RIGHT"]}}, {parents: [update.key], author: gold, note: "Right choice"});
  await approve(b, right, gold);
  await b.receive([left]);
  assert.equal(b.preview(left.key).conflict, true, "diverging approved naming versions require a choice");
  await assert.rejects(() => approve(b, left, gold), /merge review/);
  const merged = await approve(b, left, gold, "theirs");
  assert.deepEqual(new Set(merged.parents), new Set([left.key, right.key]));
  assert.deepEqual(b.library().naming.conventions, {stems: {rail: ["TEAM_LEFT"]}});
  const local = {id: "local-fixture", name: "Local only", localOnly: true};
  const localOnly = await b.proposeConventions({rs485: "B"}, {parents: [merged.key], author: local, note: "Private draft"});
  await approve(b, localOnly, local);
  assert.ok(!Core.archive(b).events.some(e => e.localOnly || e.target === localOnly.key));
  delete globalThis.AtriumGroupLocal;
}
async function test() {
  {
    const part = {id: "one", name: "Signed part", symbol: {pins: [], shapes: []}};
    const lib = {id: "same-id", name: "Team", kind: "group", defs: [part], revisionKeys: new Map([[part.id, "approved-1"]])};
    const copy = AtriumLibrary.fromLibrary(lib, part);
    const file = {id: lib.id, name: lib.name, defs: [{...part, name: "Different local file"}]};
    assert.equal(AtriumLibrary.libraryStatus(copy, [file]).missing, true);
    assert.equal(AtriumLibrary.libraryStatus(copy, [file, lib]).state, "current");
    assert.equal(AtriumLibrary.sameLibrary(file, copy.libraryRef), false);
    lib.revisionKeys.set(part.id, "approved-2");
    assert.equal(AtriumLibrary.libraryStatus(copy, [file, lib]).state, "update", "new approval ownership is reviewable even with identical geometry");
  }
  const blue = {...await Core.newSigningKey(), name: "Blue"}, gold = {...await Core.newSigningKey(), name: "Gold"};
  const a = Core.create(info), b = Core.create(info), queue = [], failures = [];
  let offline = false, writes = 0;
  function peer(me, other, group) {
    return AtriumGroupSync.create({current: () => group, send(msg) {
      if (!offline) queue.push({from: me, to: msg.to || other, msg: JSON.parse(JSON.stringify(msg))});
    }, async accept(_, items) { if ((await group.receive(items)).length) writes++; }, error: e => failures.push(e)});
  }
  const peers = {blue: peer("blue", "gold", a), gold: peer("gold", "blue", b)};
  async function flush() {
    let n = 0;
    while (queue.length) {
      assert.ok(++n < 500, "sync reached quiescence");
      const {from, to, msg} = queue.shift();
      await peers[to].receive(msg, from);
      if (["records", "inventory"].includes(msg.op)) await peers[to].receive(msg, from);
    }
    assert.deepEqual(failures, []);
  }
  const oldGroup = Core.create(info), oldSource = {kind: "kicad-symbol", footprint: {kind: "kicad-footprint"}};
  const legacy = await oldGroup.propose({...component, source: oldSource, libraryRef: {library: "kicad-official"}}, {author: blue, note: "Older official copy"});
  assert.equal(legacy.def.source.attribution.credit, "KiCad library contributors");
  assert.match(legacy.def.source.footprint.attribution.sourceUrl, /kicad-footprints/);
  const independent = await oldGroup.propose({...component, id: "home", source: oldSource}, {author: gold, note: "Original KiCad part"});
  assert.equal(independent.def.source.attribution, undefined);
  const externalRef = {library: "original-source", id: "part-1"};
  assert.equal(a.baseFor({id: "in-project-one", libraryRef: externalRef}, blue.id).component,
    b.baseFor({id: "in-project-two", libraryRef: externalRef}, gold.id).component);
  assert.notEqual(a.baseFor({id: "in-project-one", libraryRef: externalRef}, blue.id).component,
    b.baseFor({id: "in-project-one", libraryRef: {...externalRef, library: "different-source"}}, gold.id).component);
  const project = A.project("Source", [A.clone(component)]);
  AtriumLibraryStore.hoistAll(project);
  const first = await a.propose(project.library[0], {author: blue, project, note: "Initial pinout", state: "released"});
  assert.equal(a.library().defs.length, 0);
  await approve(a, first, blue);
  peers.blue.select(info.id); await flush();
  assert.equal(b.events.size, 0, "a discovery listener never downloads a library without joining");
  peers.gold.select(info.id); await flush();
  assert.equal(b.events.size, 2); assert.equal(b.library().defs.length, 0, "a remote approval is historical evidence");
  assert.equal(b.pending().length, 1);
  const received = b.pending()[0].def;
  assert.deepEqual(received.source, component.source);
  assert.deepEqual(Lib.readLibraryFile(Lib.libraryFile(a.library()).text).defs[0].source, component.source);
  assert.equal(project.library[0].model3d.file, component.model3d.file);
  assert.deepEqual(received.model3d, {...component.model3d, file:"test.step"}); assert.ok(!("password" in received.parameters));
  assert.equal(received.state, "released");
  await approve(b, first, gold);
  const design = A.project("Consumer", []), copied = Lib.addFromLibrary(b.library(), b.library().defs[0], design);
  assert.equal(copied.libraryRef.groupRevision, first.key); assert.deepEqual(copied.source, component.source);
  const before = JSON.stringify(design);
  // Each user works offline from the same approved revision. The two readable rev numbers
  // deliberately coincide. The content and ancestry identify the two distinct proposals.
  offline = true; peers.blue.disconnect(); peers.gold.disconnect();
  const leftDef = {...first.def, value: "left", symbol: {shapes: [], pins: [{number: "1", name: "L", x: -1, y: 0}]}};
  const rightDef = {...first.def, value: "right", symbol: {shapes: [], pins: [{number: "1", name: "R", x: 1, y: 0}]}};
  delete leftDef.source;
  const left = await propose(a, leftDef, first, blue, "Move pin left"), right = await propose(b, rightDef, first, gold, "Move pin right");
  await approve(a, left, blue); await approve(b, right, gold);
  offline = false; peers.gold.refresh(); await flush();
  assert.equal(a.events.size, b.events.size); assert.equal(a.heads.get("osc"), left.key); assert.equal(b.heads.get("osc"), right.key);
  const review = b.preview(left.key);
  assert.ok(review.conflict); assert.equal(review.base.key, first.key); assert.equal(review.ours.key, right.key);
  assert.deepEqual([review.ours.author.name, review.target.author.name], ["Gold", "Blue"]);
  await assert.rejects(() => b.decide({...review, confirmedIdentities: true}, "approved", gold), /merge review/);
  assert.equal(JSON.stringify(design), before);
  const merged = await b.decide({...review, confirmedIdentities: true}, "approved", gold, "theirs");
  assert.deepEqual(new Set(merged.parents), new Set([left.key, right.key]));
  assert.equal(merged.rev, 3); assert.equal(merged.def.value, "left"); assert.deepEqual(merged.def.source, component.source);
  peers.gold.announce(); await flush();
  assert.equal(a.heads.get("osc"), left.key); assert.equal(a.pending()[0].key, merged.key);
  await approve(a, merged, blue);
  assert.equal(JSON.stringify(design), before, "the project has a second, separate visual update");
  assert.equal(Lib.libraryStatus(copied, [b.library()], design).state, "update");
  Lib.updateFromLibrary(design, copied, b.library(), merged.def);
  assert.equal(design.library[0].libraryRef.groupRevision, merged.key);
  assert.deepEqual(design.library[0].source, component.source);
  peers.blue.announce(); await flush();
  const priorWrites = writes; peers.gold.refresh(); await flush(); assert.equal(writes, priorWrites, "rejoining up-to-date does no writes");
  assert.deepEqual(a.baseFor(copied, blue.id), {component: "osc", key: first.key}, "an old offline project remembers its exact base");
  const stale = await propose(a, {...merged.def, value: "A"}, merged, blue, "Change value");
  const snapshot = a.preview(stale.key);
  const fork = await propose(a, {...merged.def, value: "B"}, merged, gold, "Alternative value");
  assert.ok(a.preview(fork.key).conflict, "concurrent pending proposals also require merge review");
  await assert.rejects(() => a.decide(snapshot, "approved", blue), /changed during review/);
  await a.decide(a.preview(fork.key), "declined", blue); assert.equal(a.heads.get("osc"), merged.key);
  const removal = await a.propose(null, {component: "osc", parents: [stale.key], author: gold, note: "Remove device"});
  assert.match(AtriumLibraryDiff.svg(stale.def, null, "symbol"), /ld-del/);
  await approve(a, removal, blue); assert.equal(a.library().defs.length, 0);
  assert.equal(Lib.readLibraryFile(Lib.libraryFile(a.library()).text).tombstones[0].id, "osc");
  const pack = JSON.parse(JSON.stringify(Core.archive(a))); pack.events.reverse();
  const fromFile = await Core.readArchiveFile({text: async () => JSON.stringify(pack)});
  let reads = 0;
  const oversized = {size: 257 * 1024 * 1024, text: async () => { reads++; return "{}"; }};
  await assert.rejects(Core.readArchiveFile(oversized), /size limit/);
  await assert.rejects(Core.readGit([{...oversized, name: "waffle-groups/test/library.json"}]), /size limit/);
  assert.equal(reads, 0, "oversized picked files are rejected before loading their contents");
  assert.equal(fromFile.events.size, a.events.size); assert.equal(fromFile.heads.size, 0, "importing never installs heads");
  assert.deepEqual(fromFile.events.get(left.key).def.source, component.source);
  const damaged = JSON.parse(JSON.stringify(stale)); damaged.note = "different";
  const empty = Core.create(info);
  await assert.rejects(() => empty.receive([first, damaged]), /checksum/); assert.equal(empty.events.size, 0);
  await assert.rejects(() => empty.receive([left]), /Incomplete/); assert.equal(empty.events.size, 0);
  await assert.rejects(() => empty.receive([{...first, group: "another-group"}]), /Invalid/);
  const checking = Core.create(info);
  await checking.receive([first]); assert.equal(checking.identityStatus(first).status, "new");
  await assert.rejects(checking.decide(checking.preview(first.key), "approved", gold), /author identity/);
  await approve(checking, first, gold); assert.equal(checking.identityStatus(first).status, "known");
  const renamed = await propose(a, {...component, id: "renamed"}, null, {...blue, name: "New display name"}, "Rename fixture");
  const replacement = await propose(a, {...component, id: "replacement"}, null, {...await Core.newSigningKey(), name: "Blue"}, "New profile");
  await checking.receive([renamed, replacement]);
  assert.equal(checking.identityStatus(renamed).status, "renamed");
  assert.equal(checking.identityStatus(replacement).status, "changed");
  for (const e of [renamed, replacement]) {
    await assert.rejects(checking.decide(checking.preview(e.key), "approved", gold), /author identity/);
    assert.equal(checking.heads.has(e.component), false);
  }
  await approve(checking, replacement, gold);
  assert.equal(checking.identityStatus(replacement).status, "known");
  assert.equal(checking.identityStatus(first).status, "changed", "a superseded key must be reviewed again");
  const unsigned = {...first, author: {id: "older-profile", name: "Blue"}};
  delete unsigned.key; delete unsigned.signature;
  unsigned.key = AtriumLibraryStore.sha256(AtriumLibraryStore.canonical(unsigned));
  const older = await Core.readArchive({format: "atrium-group-library", version: 1, group: info, events: [unsigned]});
  assert.equal(older.identityStatus(unsigned).status, "unsigned");
  await assert.rejects(older.decide(older.preview(unsigned.key), "approved", blue), /author identity/);
  await approve(older, unsigned, blue);
  assert.equal(older.members.has(unsigned.author.id), false);
  const wrongSignature = {...first, signature: replacement.signature};
  const clean = Core.create(info);
  await assert.rejects(clean.receive([replacement, wrongSignature]), /signature/);
  assert.equal(clean.events.size, 0);
  const {signature, ...missing} = first;
  await assert.rejects(clean.receive([missing]), /signing identity/);
  assert.ok(!JSON.stringify(Core.archive(a)).includes("privateKey"));
  const portable = await a.proposeConventions({stems: {ground: ["RET_BENCH"]}}, {author: blue, note: "Share return net names"});
  await approve(a, portable, blue);
  peers.blue.announce(); await flush();
  assert.deepEqual(b.events.get(portable.key).conventions, portable.conventions);
  assert.equal(b.library().naming, undefined, "live receipt and remote approval leave naming pending locally");
  await namingConventions(blue, gold);
  console.log("PASS group proposals, approval, divergent offline edits, concurrent drafts, stale review, replay, rejoin, removal, visual project update and attributed bundles");
}
globalThis.__testDone = test().catch(e => { console.error(e); process.exitCode = 1; });
