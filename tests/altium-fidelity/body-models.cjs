"use strict";
// Reads only boards already fetched and verified by this corpus. No model bytes,
// geometry or proprietary source names are emitted.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const m of ["model", "source-file", "altium-ids", "pcb-pours", "pcb-import", "sexpr", "io", "board-shape", "step-import", "step-export", "undo-store", "view3d"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const corpus = require("./fixtures.json").projects, requested = process.argv[2], root = process.argv[3] || path.join(os.homedir(), ".cache/waffle/altium-fidelity");
require("../support/3d-geometry.cjs");
const options = {deterministic: true, generated: false}, A = Atrium, S = AtriumSTEP, V = Atrium3D, U = AtriumUndoStore;
async function measure(fixture) {
  const member = fixture.assets.flatMap(a => a.members || a).find(f => /\.pcbdoc$/i.test(f.path || ""));
  const input = fs.readFileSync(path.join(root, fixture.id, fixture.revision, path.basename(member.path)));
  assert.equal(crypto.createHash("sha256").update(input).digest("hex"), member.sha256);
  U.reset();
  const read = AtriumIO.read("board.PcbDoc", new Uint8Array(input));
  const project = {...A.project("Board"), documents: read.documents, library: read.library}, doc = project.documents[0];
  const history = [], future = [], before = U.mark(project), track = doc.items.find(i => i.kind === "track");
  const cache = V.meshFor(project, doc, 0, false), sources = doc.bodyModels.filter(a => !a.assetId);
  assert.equal(cache.bodyBytes, 0); assert.equal(cache.pendingBodies.size, sources.length);
  assert.ok(cache.model.parts.filter(p => p.model?.asset).every(p => !p.model.data && !p.model.text));
  track.width += .01; U.checkpoint(history, future, before, "Track width"); U.record(project, {doc, items: [track]});
  assert.equal(V.meshFor(project, doc, 1, false), cache);
  U.jump(history, future, U.mark(project), -1); U.record(project, {doc, items: [track]});
  assert.equal(V.meshFor(project, doc, 2, false), cache); assert.equal(cache.bodyBytes, 0);
  const records = doc.items.flatMap(i => i.bodies3d || []).concat(doc.bodies3d || []);
  await V.loadBodyMeshes(cache, AtriumSTEPImport);
  const built = V.buildScene(cache.meshed);
  const physical = built.parts.filter(p => p.bodyRecord);
  assert.equal(new Set(physical.map(p => p.bodyRecord)).size, records.length);
  assert.ok(physical.every(p => !p.boundsOnly));
  const model = S.model(project, doc, options), step = S.step(model, options);
  assert.equal(model.parts.filter(p => p.bodyRecord).length, records.length);
  assert.ok(!model.notes.some(n => /Unresolved STEP body|STEP body .*omitted/.test(n)));
  const storedBytes = sources.reduce((n, a) => n + Buffer.from(a.zlib, "base64").byteLength, 0);
  const expandedBytes = sources.reduce((n, a) => n + AtriumImportFormats.stepBytes(a).byteLength, 0);
  const countFaces = key => sources.reduce((n, a) => n + AtriumSTEPImport.cachedAsset(a).stats[key], 0);
  return {board:fixture.id, records:records.length, extrusions:records.filter(b => b.type === "extruded").length,
    bottom:records.filter(b => b.side === "Bottom").length, references:doc.bodyModels.length, payloads:sources.length,
    storedBytes, expandedBytes, editMeshBytes:0, visibleSTEPBytes:cache.bodyBytes, visibleBodies:physical.length,
    approximatedFaces:countFaces("approximated"), skippedFaces:countFaces("skipped"), outputSTEPBytes:Buffer.byteLength(step)};
}
(async () => {
  const fixtures = corpus.filter(p => !requested || p.id === requested);
  assert.ok(fixtures.length, "Unknown public board.");
  for (const p of fixtures) {
    console.log(JSON.stringify(await measure(p)));
    const members = p.assets.flatMap(a => a.members || a).filter(a => /\.pcblib$/i.test(a.path || ""));
    for (const member of members) {
      const input = fs.readFileSync(path.join(root, p.id, p.revision, path.basename(member.path)));
      assert.equal(crypto.createHash("sha256").update(input).digest("hex"), member.sha256);
      const {library} = AtriumIO.read(path.basename(member.path), new Uint8Array(input));
      const placed = A.sheet("pcb", "Library"), project = {...A.project("Placed"), documents: [placed], library};
      placed.outline = [[0,0], [80,0], [80,80], [0,80]];
      for (const [n, def] of library.entries()) if (def.footprint?.bodies3d) {
        const part = A.instantiate(project, def, [5 + n*2, 5 + n*2], (n*17)%360);
        part.layer = n%2 ? "Bottom" : "Top"; placed.items.push(part);
      }
      const count = library.reduce((n,d) => n + (d.footprint?.bodies3d?.length || 0), 0);
      const c = V.meshFor(project, placed, 0, false);
      await V.loadBodyMeshes(c, AtriumSTEPImport);
      const physical = V.buildScene(c.meshed).parts.filter(p => p.bodyRecord);
      assert.equal(physical.length, count);
      const out = await S.buildAsync(project, placed, options);
      assert.ok(!out.notes.some(n => /Unresolved STEP body|STEP body .*omitted/.test(n)));
      console.log(JSON.stringify({board:p.id, library:path.basename(member.path), inlineBodies:count, placedBodies:physical.length, outputSTEPBytes:Buffer.byteLength(out.data)}));
    }
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
