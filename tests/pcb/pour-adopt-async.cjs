"use strict";
// AtriumPolygonPour.adoptAsync (throughput pass): an imported Eagle board's first pour runs in
// steps (pour worker, or idle slices) and gives exactly the copper that the synchronous adopt()
// gives on first inspection.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const f of ["model", "sch-objects", "board-shape", "board-shape-sources", "stackup", "pcb-pours", "polygon-pour", "sexpr", "import-eagle", "net-ties", "connectivity", "net-intent", "signals", "rules", "import-link"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, enc = new TextEncoder();
const fixture = fs.readFileSync(path.join(__dirname, "../fixtures/import/demo-eagle.brd"), "utf8");
function board() {
  const [r] = AtriumImportFormats.readSet([{name: "demo-eagle.brd", bytes: enc.encode(fixture)}]);
  const p = A.project("Eagle"); p.documents = [r.documents[0]]; p.library = r.library; AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  return {project: p, doc: p.documents[0], defs: new Map(p.library.map(d => [d.id, d]))};
}
(async () => {
  const sync = board(), copy = AtriumSignals.attach(A.clone(sync.project));
  const slow = {doc: copy.documents[0], defs: new Map(copy.library.map(d => [d.id, d]))};
  assert.equal(sync.doc.pcbDrawing.sourceFill, "pour", "the Eagle importer asks for a first pour");
  assert.equal(AtriumPolygonPour.adopt(sync.doc, sync.defs), true);
  assert.equal(await AtriumPolygonPour.adoptAsync(slow.doc, slow.defs), true);
  assert.equal(slow.doc.pcbDrawing.sourceFill, undefined);
  assert.ok(sync.doc.pcbDrawing.pours.length > 0, "the polygon poured");
  assert.deepEqual(slow.doc.pcbDrawing, sync.doc.pcbDrawing, "same pours, links and signatures");
  assert.equal(AtriumPolygonPour.state(slow.doc, slow.defs), AtriumPolygonPour.state(sync.doc, sync.defs));
  assert.deepEqual(AtriumConnectivity.inspect(slow.doc, slow.defs), AtriumConnectivity.inspect(sync.doc, sync.defs));
  // Nothing to pour: resolves like adopt().
  assert.equal(await AtriumPolygonPour.adoptAsync(slow.doc, slow.defs), false);
  const abandoned = board(), before = JSON.stringify(abandoned.doc);
  let cancel;
  const signal = {aborted:false, addEventListener(_type, fn) {cancel = fn;}, removeEventListener() {cancel = null;}};
  const pending = AtriumPolygonPour.adoptAsync(abandoned.doc, abandoned.defs, {signal});
  signal.aborted = true; cancel();
  let aborted = false;
  try { await pending; } catch(e) { aborted = e.name === "AbortError"; }
  assert.equal(aborted, true);
  assert.equal(JSON.stringify(abandoned.doc), before, "cancel leaves the unopened import untouched");
  assert.equal(cancel, null, "no abort listener remains");
  console.log("pour-adopt-async: Eagle first pour in steps matches adopt() (" + slow.doc.pcbDrawing.pours.length + " regions) OK");
})().catch(e => { console.error(e); process.exitCode = 1; throw e; });
