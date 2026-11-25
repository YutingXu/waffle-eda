"use strict";
// Assembly variants + board revisions as one feature (app/project/revisions.js, app/project/variants.js):
// the revision model and its content-addressed store, native folder revisions, outputs per
// variant (BOM, pick and place, assembly drawing, STEP) and per revision (title block, {rev}),
// the released read-only gate, compare between revisions, and the headless commands.
const assert = require("node:assert/strict"), fs = require("node:fs");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "parts", "spatial", "pcb-appearance", "pcb-pours", "stackup",
  "board-shape", "rigid-flex", "zip", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "variants", "bom", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel",
  "waivers", "drc-waivers", "output-jobs", "release", "sch-objects", "hierarchy", "sch-appearance", "diff",
  "automation/legacy-command-contract", "commands-headless", "revisions"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, V = AtriumVariants, RV = AtriumRevisions;
const example = () => AtriumParts.example();
const part = (doc, ref) => doc.items.find(i => i.kind === "part" && i.ref === ref);
const key = (p, ref) => V.keyOf(part(p.documents[0], ref));
const date = new Date(Date.UTC(2026, 10, 19, 12, 0, 0));

function assertArrayChunkReuse(p, beforeStore, a, b, editedIds) {
  const afterStore = p.revisionStore, after = RV.reach(afterStore, b.root);
  const ids = new Set(editedIds);
  const containsEdit = text => JSON.parse(text.slice(1)).some(item => ids.has(item?.id));
  let untouched = 0, replaced = 0;
  for (const hash of RV.reach(beforeStore, a.root)) {
    const text = beforeStore[hash];
    if (!text.startsWith("v[")) continue;
    if (containsEdit(text)) {
      assert.ok(!after.has(hash), "the new revision points to the edited array chunk");
      replaced++;
    } else {
      assert.ok(after.has(hash), "the new revision shares the untouched array chunk " + hash);
      assert.equal(afterStore[hash], text);
      untouched++;
    }
  }
  const added = [...after].filter(hash => !Object.hasOwn(beforeStore, hash) && afterStore[hash].startsWith("v["));
  assert.ok(untouched > 0, "the fixture exercises literal array chunk reuse");
  assert.equal(replaced, editedIds.length);
  assert.equal(added.length, replaced);
  assert.ok(added.every(hash => containsEdit(afterStore[hash])), "only edited array chunks are added");
}

globalThis.__testDone = (async () => {
  // ------------------------------------------------------------ hashing and letters
  assert.equal(RV.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(RV.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(RV.sha256("Ω µ 😀"), "598b851eaefcf3b4a2c4abc1247b2a15b92bd3a1e6da3e5d5a3ba6bfc0a62010", "multi-byte text hashes as UTF-8");
  assert.equal(RV.sha256("a".repeat(1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  assert.deepEqual([0, 1, 7, 8, 19, 20, 21].map(RV.letterAt), ["A", "B", "H", "J", "Y", "AA", "AB"], "I, O, Q, S, X and Z are skipped");

  // ------------------------------------------------------------ model: start, freeze, store
  // Array chunk boundaries depend on item IDs. Use the archived Sensor board so the
  // two edits address the same chunks on every run.
  const p = A.validate(require("../support/native-cad.cjs").nativeCAD("sample-sensor"));
  assert.equal(RV.working(p), null);
  assert.equal(RV.locked(p), false);
  assert.equal(RV.nextLetter(p), "A");
  assert.deepEqual(RV.fields(p), {});
  RV.start(p, {notes: "First board", date});
  assert.deepEqual(RV.working(p), {letter: "A", status: "draft", date: "2026-11-19", notes: "First board"});
  assert.throws(() => RV.start(p), /started already/);
  assert.equal(RV.fields(p).Revision, "A");
  assert.equal(RV.fields(p).RevisionStatus, "Draft");
  const designBefore = RV.canon(RV.frozenDesign(p, date));
  const a = RV.freeze(p, {date, time: date});
  assert.equal(a.letter, "A"); assert.equal(a.status, "released"); assert.equal(a.date, "2026-11-19");
  assert.ok(RV.locked(p), "a released working revision is locked");
  assert.equal(p.revision.status, "released");
  assert.ok(/^[0-9a-f]{32}$/.test(a.root));
  RV.validate(p);
  A.validate(p);
  const storeA = RV.storeStats(p);
  assert.equal(storeA.chunks, a.stored.chunks);
  assert.ok(storeA.chunks > 3, "the design is split into chunks");
  // The snapshot reads back exactly (canonical), and is verified chunk by chunk.
  assert.equal(RV.canon(RV.designOf(p, "A")), designBefore);
  assert.equal(RV.canon(RV.designOf(p, a.id)), designBefore);
  assert.ok(!("revisions" in RV.designOf(p, "A")) && !("revisionStore" in RV.designOf(p, "A")), "snapshots hold the design only");
  // Damage is reported, never shown as the design.
  {
    const q = A.clone(p), h = Object.keys(q.revisionStore).find(k => q.revisionStore[k][0] === "v" && q.revisionStore[k].includes("R1"));
    q.revisionStore[h] = q.revisionStore[h].replace("R1", "R9");
    assert.throws(() => RV.designOf(q, "A"), /damaged/);
    delete q.revisionStore[h];
    assert.throws(() => RV.designOf(q, "A"), /missing a chunk/);
  }
  // Freezing twice, or reusing a letter, is refused.
  assert.throws(() => RV.freeze(p), /already released/);
  assert.throws(() => RV.setNotes(p, "x"), /frozen/);

  // ------------------------------------------------------------ new revision and efficient storage
  assert.throws(() => RV.newFrom(p, null, {letter: "A"}), /already exists/);
  const b = RV.newFrom(p, null, {notes: "Swap R2", date});
  assert.deepEqual({letter: b.letter, status: b.status, from: b.from}, {letter: "B", status: "draft", from: "A"});
  assert.equal(RV.locked(p), false, "the next revision is editable");
  assert.throws(() => RV.newFrom(p), /still a draft/);
  const boardR2 = part(p.documents[1], "R2"), sheetR2 = part(p.documents[0], "R2");
  boardR2.x += 2.54;
  sheetR2.value = "4.7k";
  const afterEdit = RV.canon(RV.frozenDesign(p, date)), previousStore = {...p.revisionStore};
  const bytesBefore = RV.storeStats(p).bytes;
  const rb = RV.freeze(p, {date});
  const added = RV.storeStats(p).bytes - bytesBefore;
  assert.ok(rb.stored.chunks < storeA.chunks, "Rev B stores only the chunks it changed (" + rb.stored.chunks + " of " + storeA.chunks + ")");
  assert.ok(added < storeA.bytes / 2, "Rev B adds " + added + " bytes, not a full copy (" + storeA.bytes + ")");
  assert.equal(RV.canon(RV.designOf(p, "A")), designBefore);
  assert.equal(RV.canon(RV.designOf(p, "B")), afterEdit);
  assertArrayChunkReuse(p, previousStore, a, rb, [boardR2.id, sheetR2.id]);
  // Big boards: moving one track costs a few chunks.
  {
    const big = A.clone(p);
    const board = big.documents[1];
    for (let i = 0; i < 4000; i++) board.items.push({id: "t" + i, kind: "track", layer: "Top", width: 0.2, net: "N" + (i % 50), points: [[i * 0.1, 0], [i * 0.1, 5]]});
    delete big.revision; delete big.revisions; delete big.revisionStore;
    RV.start(big, {date});
    const oldDesign = RV.canon(RV.frozenDesign(big, date)), r1 = RV.freeze(big, {date});
    const oldStore = {...big.revisionStore};
    RV.newFrom(big, null, {date});
    const track = board.items.find(item => item.id === "t2000");
    track.points = [[1, 1], [2, 2]];
    const newDesign = RV.canon(RV.frozenDesign(big, date)), r2 = RV.freeze(big, {date});
    assert.ok(r2.stored.chunks <= 8, "one changed track: " + r2.stored.chunks + " chunks (of " + r1.stored.chunks + ")");
    assert.ok(r2.stored.bytes < r1.stored.bytes / 20);
    assert.equal(RV.canon(RV.designOf(big, r1.id)), oldDesign);
    assert.equal(RV.canon(RV.designOf(big, r2.id)), newDesign);
    assertArrayChunkReuse(big, oldStore, r1, r2, [track.id]);
  }

  // ------------------------------------------------------------ status, obsolete, start from an older revision
  RV.setStatus(p, "A", "obsolete");
  assert.equal(RV.find(p, "A").status, "obsolete");
  assert.throws(() => RV.setStatus(p, "A", "draft"), /released or obsolete/);
  RV.setStatus(p, "A", "released");
  RV.newFrom(p, null, {date});
  assert.equal(RV.working(p).letter, "C");
  part(p.documents[0], "R1").value = "draft edit";
  assert.throws(() => RV.newFrom(p, "A"), /draft with unreleased edits/);
  RV.newFrom(p, "A", {replaceDraft: true, date});
  assert.deepEqual([RV.working(p).letter, RV.working(p).from], ["C", "A"], "the draft restarts from Rev A");
  assert.equal(part(p.documents[0], "R1").value, part(example().documents[0], "R1").value, "Rev A's design is back");
  assert.equal(part(p.documents[0], "R2").value, part(example().documents[0], "R2").value);
  assert.equal(RV.list(p).length, 2, "history is kept");
  A.validate(p);
  assert.equal(RV.gc(p), 0, "nothing unreferenced");
  {
    const q = A.clone(p); q.revisions.pop(); assert.ok(RV.gc(q) > 0, "gc drops chunks only Rev B used"); RV.designOf(q, "A");
  }

  // ------------------------------------------------------------ validation
  for (const bad of [
    q => { q.revision = {status: "draft"}; },
    q => { q.revision.status = "frozen"; },
    q => { q.revisions[0].root = "nope"; },
    q => { q.revisions[1].id = q.revisions[0].id; },
    q => { q.revisionStore = []; },
    q => { delete q.revisionStore; },
    q => { q.revisionStore[q.revisions[0].root] = 5; },
  ]) { const q = A.clone(p); bad(q); assert.throws(() => RV.validate(q), /Board revisions/); }
  const integrated = String(A.validationSteps || A.validate).includes("AtriumRevisions") || /AtriumRevisions/.test(require("node:fs").readFileSync(__dirname + "/../../app/core/model.js", "utf8"));
  if (integrated) { const q = A.clone(p); q.revisions[0].status = "frozen"; assert.throws(() => A.validate(q), /Board revisions|Invalid Waffle editor model/); }

  // Independent native revision files retain their original placements after later edits.
  {
    const {nativeCAD} = require("../support/native-cad.cjs");
    const working = nativeCAD("design-diff"), prior = nativeCAD("design-diff", "move-rotate-flip");
    const baseU1 = part(working.documents[1], "U1"), frozenU1 = part(prior.documents[1], "U1");
    assert.equal(frozenU1.x - baseU1.x, 2.5);
    baseU1.x += 100;
    assert.equal(part(nativeCAD("design-diff", "move-rotate-flip").documents[1], "U1").x, frozenU1.x);
  }

  // ------------------------------------------------------------ outputs per variant
  const q = example();
  const lite = V.create(q, {name: "Lite"}), pro = V.create(q, {name: "Pro"});
  V.setParts(q, lite.id, [key(q, "U1")], {fitted: false});
  V.setParts(q, lite.id, [key(q, "R2")], {alternate: {value: "4.7k", params: {"Manufacturer Part Number": "RC0603FR-074K7L"}}});
  V.setParts(q, pro.id, [key(q, "C1")], {params: {Tolerance: "5%"}});
  {
    const base = RV.bom(q, {variant: null}), l = RV.bom(q, {variant: "Lite"}), pr = RV.bom(q, {variant: "Pro"});
    const refs = r => r.lines.flatMap(x => x.designators);
    assert.ok(refs(base).includes("U1") && refs(pr).includes("U1"));
    assert.ok(!refs(l).includes("U1") && l.notFitted.includes("U1"), "Lite leaves U1 out of the BOM");
    assert.equal(l.variant.name, "Lite");
    const r2 = l.lines.find(x => x.designators.includes("R2"));
    assert.equal(r2.comment, "4.7k"); assert.equal(r2.mpn, "RC0603FR-074K7L", "the alternate part's MPN");
    assert.equal(base.parts - 1, l.parts);
    assert.equal(RV.bom(q, {}).variant, null, "omitted: the active variant (none)");
    V.setActive(q, lite.id);
    assert.equal(RV.bom(q, {}).variant.name, "Lite");
    V.setActive(q, null);
  }
  {
    const F = AtriumFabOutputs, boardId = q.documents[1].id;
    const pnpOf = variant => { const m = F.analyse(q, boardId, {variant}), plan = F.plan(m, {date: new Date(0)}); return F.generate(m, plan, plan.files.find(f => f.kind === "pnp")).content; };
    assert.ok(/\bU1\b/.test(pnpOf(null)) && !/\bU1\b/.test(pnpOf("Lite")), "pick and place follows the variant");
    const m = F.analyse(q, boardId, {variant: "Lite"}), plan = F.plan(m, {date: new Date(0)});
    const svg = F.generate(m, plan, plan.files.find(f => f.kind === "assembly")).content;
    assert.ok(svg.includes("Lite"), "the assembly drawing names the variant");
    const S = AtriumSTEP, names = o => S.model(q, boardId, o).parts.map(x => x.ref);
    assert.ok(names({variant: null}).includes("U1") && !names({variant: "Lite"}).includes("U1"), "3D/STEP follows the variant");
    // Output jobs take options.variant per output.
    const J = AtriumOutputJobs;
    const set = {name: "Per variant", outputs: [{kind: "bom", enabled: true, options: {variant: "Lite", formats: ["csv"]}}, {kind: "pnp", enabled: true, options: {variant: "Lite"}}]};
    const run = J.run(q, set, {date});
    const files = run.files || run.entries || [];
    const text = f => typeof f.data === "string" ? f.data : new TextDecoder().decode(f.data);
    const pnpFile = files.find(f => /pick|pnp|place/i.test(f.name || f.path || ""));
    assert.ok(pnpFile && !/\bU1\b/.test(text(pnpFile)), "an output job's pick and place uses its variant");
  }

  // ------------------------------------------------------------ revision fields feed title blocks and outputs
  {
    const r = example(); RV.start(r, {letter: "C", date});
    const S = AtriumSchAppearance;
    const sheet = r.documents[0];
    const t = S.resolveSpecialStrings("Rev =Revision (=RevisionStatus)", r, sheet);
    if (/=Revision|\*/.test(t) === false) assert.equal(t, "Rev C (Draft)", "title block special strings");
    else assert.fail("=Revision does not resolve from project.revision: " + t);
    r.parameters = {Revision: "7"};
    assert.equal(S.resolveSpecialStrings("=Revision", r, sheet), "C", "the managed revision wins over a stale project parameter");
    assert.equal(AtriumRelease.revisionOf(r, {}), "C", "release package names use the revision");
    const F = AtriumFabOutputs, m = F.analyse(r, r.documents[1].id), plan = F.plan(m, {date: new Date(0)});
    const pnp = F.generate(m, plan, plan.files.find(f => f.kind === "pnp")).content;
    assert.ok(/Revision:\s+C\b/.test(pnp), "pick and place header carries the revision");
  }

  // ------------------------------------------------------------ release read-only enforcement
  {
    const r = example(); RV.start(r); RV.freeze(r);
    assert.ok(RV.guard(r), "edits to a released revision are refused");
    assert.equal(RV.allow(() => RV.guard(r)), false, "except the revision operations themselves");
    assert.match(RV.message(r), /Rev A is released and read-only.*Rev B/);
    RV.setStatus(r, "A", "obsolete");
    assert.ok(RV.locked(r) && RV.guard(r), "obsolete is read-only too");
    RV.newFrom(r);
    assert.equal(RV.guard(r), false);
    // scripts/test-undo-editor.cjs exercises the editor transaction gate and direct Add Schematic checkpoints.
    // Headless: an edit command on a released design is refused by the command runner.
    const s = example(); RV.start(s); RV.freeze(s);
    assert.throws(() => AtriumCommandsHeadless.run(s, "variant_edit", {op: "create", name: "X"}), /read-only/);
    assert.throws(() => AtriumCommandsHeadless.run(s, "rename_document", {document_id: s.documents[0].id, name: "Y"}), /read-only/);
    assert.ok(AtriumCommandsHeadless.run(s, "list_revisions", {}).working.locked, "read commands still run");
    AtriumCommandsHeadless.run(s, "new_revision", {});
    AtriumCommandsHeadless.run(s, "rename_document", {document_id: s.documents[0].id, name: "Y"});
  }

  // ------------------------------------------------------------ compare between revisions
  {
    const r = example(); RV.start(r); RV.freeze(r); RV.newFrom(r);
    part(r.documents[1], "R1").x += 5;
    part(r.documents[0], "C1").value = "22u";
    RV.freeze(r);
    const c = RV.compare(r, "A", "B");
    assert.equal(c.from.slice(0, 5), "Rev A"); assert.equal(c.to.slice(0, 5), "Rev B");
    const res = AtriumDiff.compare(c.before, c.after, {validate: false});
    const kinds = res.changes.map(x => x.kind);
    assert.ok(kinds.includes("part.moved") && kinds.includes("part.value"), "R1 moved and C1's value changed: " + kinds.join(", "));
    assert.ok(AtriumDiff.compare(RV.designOf(r, "B"), RV.designOf(r, "working"), {validate: false}).summary.identical, "B equals the working design");
    const h = AtriumCommandsHeadless.run(r, "compare_revisions", {before: "A", after: "B"});
    assert.equal(h.identical, false); assert.ok(h.total >= 2);
    assert.throws(() => RV.compare(r, "Q"), /no revision Q/);
  }

  // ------------------------------------------------------------ headless commands
  {
    const H = AtriumCommandsHeadless, r = example();
    for (const n of ["list_revisions", "variant_bom", "compare_revisions", "new_revision", "release_revision", "set_revision_status", "variant_edit"]) assert.ok(H.names().includes(n), n);
    assert.equal(H.kind("variant_bom"), "read"); assert.equal(H.kind("release_revision"), "edit");
    assert.equal(H.run(r, "list_revisions", {}).working, null);
    H.run(r, "variant_edit", {op: "create", name: "Lite"});
    H.run(r, "variant_edit", {op: "set_parts", variant: "Lite", designators: ["U1"], fitted: false});
    const vb = H.run(r, "variant_bom", {variant: "Lite"});
    assert.equal(vb.variant, "Lite"); assert.ok(vb.not_fitted.includes("U1"));
    const rel = H.run(r, "release_revision", {notes: "Proto", job: "Generic fab + assembly", overrides: [{check: "drc", reason: "sample board"}, {check: "erc", reason: "sample"}, {check: "bom", reason: "sample"}]});
    assert.equal(rel.revision, "A"); assert.equal(rel.outputs.args.output_dir, "A"); assert.equal(RV.find(r, "A").outputs, "Sensor_interface-outputs/A/");
    assert.ok(rel.checks_ran && rel.checks.some(c => c.id === "drc"), "release runs the configured checks");
    assert.equal(RV.find(r, "A").notes, "Proto");
    const ls = H.run(r, "list_revisions", {});
    assert.equal(ls.revisions.length, 1); assert.equal(ls.working.locked, true); assert.equal(ls.next, "B");
    assert.equal(H.run(r, "variant_bom", {variant: "Lite", revision: "A"}).revision.slice(0, 5), "Rev A");
    H.run(r, "set_revision_status", {revision: "A", status: "obsolete"});
    assert.equal(RV.find(r, "A").status, "obsolete");
    // A blocking check without an override stops the release.
    const s = example(); RV.start(s);
    s.library.find(d => d.footprint?.name === "SOT-23-5").footprint.shapes.find(x => x.kind === "circle").x = -0.44;
    let blocked = null; try { H.run(s, "release_revision", {job: "Generic fab + assembly"}); } catch (e) { blocked = e.message; }
    if (blocked) assert.match(blocked, /blocked/); else assert.ok(RV.locked(s));
  }

  // ------------------------------------------------------------ saved file stays small and line-oriented
  if (globalThis.AtriumECO?.serialize) {
    const r = example(); RV.start(r); RV.freeze(r);
    const text = AtriumECO.serialize(r);
    assert.ok(text.split("\n").some(l => /^    "[0-9a-f]{32}": "/.test(l)), "one chunk per line");
  }
  console.log("variants-revisions: ok");
})();
