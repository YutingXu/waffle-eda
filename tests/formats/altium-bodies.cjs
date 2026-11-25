"use strict";
// The licensed board exercises binary compound streams, native storage and real
// source meshes. The asymmetric two-body component covers holes and both sides.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const module of ["model", "board-shape", "source-file", "altium-ids", "altium-rules", "pcb-import", "pcb-patch", "source-copy", "sexpr", "io",
  "step-import", "step-export", "undo-store", "view3d", "altium-export", "import-worker-client"]) require(require("../support/app-source-paths.cjs").appFile(module + ".js"));

const {reopenAltium} = require("../support/altium-folder.cjs");
require("../support/3d-geometry.cjs");
const A = Atrium, S = AtriumSTEP, I = AtriumSTEPImport, V = Atrium3D, U = AtriumUndoStore;
const dir = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
const name = "PiDP11IOExpander.PcbDoc", original = new Uint8Array(fs.readFileSync(path.join(dir, name)));
const enc = new TextEncoder(), fmt = AtriumImportFormats;
const projectFor = parsed => ({...A.project("Bodies"), documents: parsed.documents, library: parsed.library});
const records = doc => doc.items.flatMap(i => i.bodies3d || []).concat(doc.bodies3d || []);
const near = (a, b, tolerance = .00002) => assert.ok(Math.abs(a - b) <= tolerance, a + " versus " + b);
const file = (f, counter) => ({name: f.name, size: f.bytes.length, async arrayBuffer() { counter.n++; return f.bytes; }});

// Public PiDP Rev A (BSD-2-Clause), saved as ASCII by Altium Designer 26.12.2.9.
// Normalize numerical formatting and record order. This independent checksum covers
// every owner/model identity, transform, height, colour and native contour vertex.
function nativeBodySignature(content) {
  const rows = content.split(/\r\n|\r|\n/).filter(s => /(?:^|\|)RECORD=ComponentBody\|/.test(s))
    .map(s => Object.fromEntries(s.split("|").filter(v => v.includes("=")).map(v => v.split("="))))
    .sort((a, b) => Number(a.COMPONENT) - Number(b.COMPONENT));
  const measured = rows.map(p => {
    const ticks = key => Math.round(Number(p[key].replace(/mil$/, "")) * 10000);
    const angles = ["MODEL.2D.ROTATION", "MODEL.3D.ROTX", "MODEL.3D.ROTY", "MODEL.3D.ROTZ"].map(key => +p[key]);
    const vertices = Array.from({length: +p.MAINCONTOURVERTEXCOUNT}, (_, i) => [
      +p["KIND" + i], ticks("VX" + i), ticks("VY" + i), ticks("CX" + i), ticks("CY" + i),
      +p["SA" + i], +p["EA" + i], ticks("R" + i)]);
    return [+p.COMPONENT, p.MODELID, p["MODEL.NAME"], +p["MODEL.CHECKSUM"], +p["MODEL.MODELTYPE"], p.LAYER, p.IDENTIFIER,
      +p.BODYPROJECTION, +p.BODYCOLOR3D, +p.BODYOPACITY3D, ticks("STANDOFFHEIGHT"), ticks("OVERALLHEIGHT"),
      ticks("MODEL.2D.X"), ticks("MODEL.2D.Y"), ticks("MODEL.3D.DZ"), ...angles, p.ISSHAPEBASED,
      +p.MAINCONTOURVERTEXCOUNT, +p.HOLECOUNT, ...vertices];
  });
  return AtriumSourceFile.sha256(enc.encode(JSON.stringify(measured)));
}

async function checkBodyWorker() {
  const globals = ["Worker","Blob","URL","DecompressionStream"], saved = globals.map(k => globalThis[k]);
  const counts = {start:0, stop:0, sent:[]};
  globalThis.Blob = class {constructor(parts) {this.source = parts.join("");}};
  globalThis.URL = {createObjectURL:blob => blob.source, revokeObjectURL() {}};
  globalThis.DecompressionStream ||= class {};
  globalThis.Worker = class {
    constructor(source) {
      counts.start++;
      this.read = new Function("postMessage", "let onmessage;" + source + ";return onmessage;")(data => {
        Promise.resolve().then(() => { if (!this.stopped) this.onmessage?.({data}); });
      });
    }
    postMessage(batch) {counts.sent.push(batch.length); Promise.resolve().then(() => this.read({data:batch}));}
    terminate() {counts.stop++; this.stopped = true;}
  };
  try {
    const text = fs.readFileSync(path.join(__dirname,"../fixtures/mcad/tray.step"),"utf8");
    const asset = n => ({stepText:text + "\n/* " + n + " */"});
    const inputs = Array.from({length:10}, (_, i) => asset(i)), results = [];
    await I.readAssets(inputs, {}, (input, result) => {assert.equal(input, inputs[results.length]); results.push(result);});
    assert.deepEqual(counts, {start:1,stop:1,sent:[8,2]});
    const expected = I.tessellate(text);
    for (const result of results) assert.deepEqual(result.parts, expected.parts);
    await I.readAssets(inputs, {}, (input, result) => assert.equal(result, I.cachedAsset(input)));
    assert.equal(counts.start, 1, "reopening the identical assets needs no worker");
    const abort = new AbortController(), cancelled = [asset("first"),asset("second")], received = [];
    await assert.rejects(() => I.readAssets(cancelled, {signal:abort.signal}, input => {received.push(input);abort.abort();}), /cancelled/);
    assert.deepEqual(received, [cancelled[0]]);
    assert.equal(I.cachedAsset(cancelled[1]), null);
    assert.equal(counts.stop, 2, "the unfinished request terminates only its own worker");
  } finally {
    globals.forEach((k, i) => { if (saved[i] === undefined) delete globalThis[k]; else globalThis[k] = saved[i]; });
  }
}

async function run() {
  let inflations = 0;
  globalThis.AtriumImportFormats = {...fmt, stepText(asset) { inflations++; return fmt.stepText(asset); }};
  const parsed = AtriumIO.read(name, original), project = projectFor(parsed), doc = parsed.documents[0];
  assert.equal(doc.bodyModelVersion, 1);
  assert.equal(records(doc).length, 23); assert.equal(doc.bodyModels.length, 8);
  assert.deepEqual(new Set(records(doc).map(b => b.modelId)), new Set(doc.bodyModels.map(a => a.id)));
  assert.ok(records(doc).every(b => b.type === "step" && b.rings[0].length >= 3 && b.shapeRecord));
  assert.ok(doc.bodyModels.every(a => a.zlib && !a.stepText));
  if (typeof DecompressionStream === "function" && typeof ReadableStream === "function") {
    // Model the native file-origin worker where Blob.stream() throws a NotReadableError.
    const stream = Blob.prototype.stream;
    try {
      Blob.prototype.stream = () => { throw Error("The I/O read operation failed."); };
      const a = doc.bodyModels[0];
      const text = await I.decodeAsset(a, 32 * 1048576);
      assert.equal(AtriumSourceFile.sha256(enc.encode(text)), "68d05d5fa0eb9b21b39e90eb3070db583843c3a91a639fb6e64454388c12769b");
      await assert.rejects(() => I.decodeAsset(a, 32768), /exceeds/);
    } finally { Blob.prototype.stream = stream; }
  }
  const stored = reopenAltium(project,{name,bytes:original},undefined,{loadModels:false});
  assert.equal(stored.modelReads,0,"opening the native owner reads no external STEP payload");
  const savedDoc=stored.project.documents[0];
  assert.deepEqual(savedDoc.bodyModels.map(m=>[m.id,m.file]),doc.bodyModels.map(m=>[m.id,m.file]));
  assert.ok(savedDoc.bodyModels.every(m=>m.model?.sha256 && !m.stepText && !m.zlib));
  assert.deepEqual(records(savedDoc).map(b=>[b.sourceRecord,b.shapeRecord,b.modelId]),
    records(doc).map(b=>[b.sourceRecord,b.shapeRecord,b.modelId]));
  assert.deepEqual(AtriumSourceCopy.prepare(savedDoc,stored.project.library,original,{provenance:stored.retained}).bytes,original);
  U.reset();
  const history = [], future = [], mark = () => U.mark(project, {current: doc.id});
  const before = mark(), cache = V.meshFor(project, doc, 0, false), track = doc.items.find(i => i.kind === "track");
  const assets = doc.bodyModels, initial = cache.meshed.parts[0].positions;
  assert.equal(cache.pendingBodies.size, 8); assert.equal(cache.bodyBytes, 0);
  assert.ok(cache.model.parts.filter(p => p.bodyRecord).every(p => assets.includes(p.model.asset) && !p.model.text && !p.model.data));
  assert.ok(!cache.meshed.parts.some(p => p.bodyRecord));
  track.width += .01; U.checkpoint(history, future, before, "Track width"); U.touch(project); U.sync();
  for (const direction of [0, -1, 1]) {
    if (direction) { U.jump(history, future, mark(), direction); U.touch(project); U.record(project, {doc, items: [track]}); }
    assert.equal(doc.bodyModels, assets);
    const next = V.meshFor(project, doc, direction + 3, false);
    assert.ok(next === cache, "the shared revision preserves the body cache on " + direction);
    assert.equal(cache.meshed.parts[0].positions, initial);
  }
  assert.equal(inflations, 0, "opening, saving, editing, undoing and redoing do not inflate STEP");
  // A supported binary track edit must leave every original model, flat body
  // and exact shape stream bit-for-bit intact, including the unused models.
  const copy = AtriumSourceCopy.prepare(doc, project.library, original);
  assert.equal(copy.records.length, 1);
  const sourceStreams = AtriumIO.streams(original), copyStreams = AtriumIO.streams(copy.bytes);
  for (const [k, v] of sourceStreams) if (/^(?:models|(?:shapebased)?componentbodies6)\//.test(k)) assert.deepEqual(copyStreams.get(k), v);
  const copyBoard = AtriumIO.read(name, copy.bytes).documents[0];
  near(copyBoard.items.find(i => i.sourceRecord === track.sourceRecord).width, track.width);
  assert.equal(records(copyBoard).length, 23); assert.equal(inflations, 0);
  const legacy = {...doc, bodyModels: assets.map(({checksum,...a}) => a)};
  assert.deepEqual(AtriumSourceCopy.prepare(legacy, project.library, original).bytes, copy.bytes, "earlier imports keep the source checksums");
  await V.loadBodyMeshes(cache, I);
  assert.equal(cache.pendingBodies.size, 0); assert.ok(cache.bodyBytes > 0);
  assert.equal(new Set(cache.meshed.parts.filter(p => p.bodyRecord).map(p => p.bodyRecord)).size, 23);
  const scene = V.buildScene(cache.meshed);
  assert.equal(scene.parts.length, 23); assert.ok(scene.parts.every(p => !p.boundsOnly));
  const repeats = new Map();
  for (const p of cache.model.parts) {
    const data = cache.meshed.parts.find(q => p.bodyRecord && q.bodyRecord === p.bodyRecord);
    if (!data) continue;
    if (repeats.has(p.bodyId)) assert.equal(data.positions, repeats.get(p.bodyId));
    repeats.set(p.bodyId, data.positions);
  }
  assert.equal(stored.modelReads,0,"editing and Undo do not acquire native model bytes");
  const reopened=stored.withModels();
  assert.equal(stored.modelReads,8);
  for (const [i,asset] of doc.bodyModels.entries()) {
    const recovered=reopened.documents[0].bodyModels[i];
    assert.equal(recovered.stepText,fmt.stepText(asset));
    assert.equal(AtriumSourceFile.sha256(enc.encode(recovered.stepText)),recovered.model.sha256);
  }
  const prior = inflations;
  for (const asset of reopened.documents[0].bodyModels) assert.equal(await I.loadAsset(asset), I.cachedAsset(asset));
  assert.equal(inflations, prior, "native reopen reuses geometry from identical source bytes");
  const opts = {deterministic: true, generated: false};
  const out = S.build(project, doc, opts), repeated = inflations;
  const nativeAssembly=S.build(reopened,reopened.documents[0],opts).data;
  const secondSave=reopenAltium(reopened,{name,bytes:original},stored.entry).project;
  assert.equal(S.build(secondSave,secondSave.documents[0],opts).data,nativeAssembly,
    "the complete deterministic STEP assembly is byte-identical across native saves");
  const beforeLines=out.data.split("\n"),nativeLines=nativeAssembly.split("\n");
  assert.equal(nativeLines.length,beforeLines.length);
  const decimals=/[-+]?(?:\d+\.\d*|\.\d+)(?:E[-+]?\d+)?/gi;
  for (const [i,line] of beforeLines.entries()) {
    const saved=nativeLines[i];
    if (line===saved) continue;
    assert.match(line,/^#\d+=(?:CARTESIAN_POINT|CIRCLE|CYLINDRICAL_SURFACE)\(/);
    assert.equal(line.replace(decimals,"<decimal>"),saved.replace(decimals,"<decimal>"),"entity IDs, topology and units stay exact");
    const current=saved.match(decimals).map(Number);
    for (const [n,number] of line.match(decimals).entries()) near(Number(number),current[n],.000001);
  }
  assert.ok(out.data.includes("(22.7750002,17.145,0.)") && nativeAssembly.includes("(22.775,17.145,0.)"));
  assert.equal(inflations, repeated, "a second export reuses parsed STEP B-reps");
  const reopenedSTEP = I.ensure(out.data);
  assert.ok(reopenedSTEP.stats.solids >= 24); assert.ok(reopenedSTEP.parts.some(p => p.indices.length > 0));
  const bundle = AtriumAltiumExport.exportProject(project), board = bundle.files.find(f => /\.PcbDoc$/i.test(f.name));
  assert.equal(nativeBodySignature(board.content), "46b68eb1044edbdc3eeaf2a5026a82b5017a2e8c922e18a0d258fa8ea94373c2");
  const bodyRows = board.content.split(/\r?\n/).filter(row => row.startsWith("|RECORD=ComponentBody|"));
  assert.equal(bodyRows.length, 23);
  assert(bodyRows.every(row => /\|MODEL\.EMBED=FALSE(?:\||$)/.test(row) && /\|MODEL\.MODELSOURCE=Undefined(?:\||$)/.test(row)),
    "Designer’s linked-model fields describe the external STEP members");
  assert.match(bundle.diagnostics.join("\n"), /plain extrusions/);
  assert.match(bundle.diagnostics.join("\n"), /Altium source copy/);
  const ascii = AtriumIO.read(board.name, board.bytes), sidecars = bundle.files.filter(f => /\.step$/i.test(f.name));
  assert.equal(sidecars.length, 8); assert.equal(records(ascii.documents[0]).length, 23);
  const indices = d => records(d).map(b => [b.sourceRecord, b.shapeRecord, b.modelId].join(" ")).sort();
  assert.deepEqual(indices(ascii.documents[0]), indices(doc));
  const restoreWorker = require("../support/import-worker.cjs")();
  const opened = {n: 0};
  await AtriumImport.attachBodyModels([ascii], [{name: board.name}], sidecars.map(f => file(f, opened)), {check() {}});
  restoreWorker();
  assert.equal(opened.n, 8); assert.ok(ascii.documents[0].bodyModels.every(a => a.stepText));
  const refs = new Map(ascii.documents[0].bodyModels.map(a => [a.id, a]));
  for (const a of assets) assert.deepEqual(sidecars.find(f => f.name === refs.get(a.id).file).bytes, fmt.stepBytes(a));
  const back = S.model(projectFor(ascii), ascii.documents[0], opts);
  assert.equal(back.parts.filter(p => p.bodyRecord && p.model.data).length, 23);
  const pack = "RECORD=Board|VX0=0mm|VY0=0mm|VX1=20mm|VY1=0mm|VX2=20mm|VY2=20mm|VX3=0mm|VY3=20mm";
  const component = "RECORD=Component|ID=0|LAYER=BOTTOM|PATTERN=Pocket|SOURCEDESIGNATOR=U1|X=10mm|Y=10mm|ROTATION=90";
  const outline = "|VX0=8mm|VY0=9mm|VX1=15mm|VY1=9mm|VX2=15mm|VY2=14mm|VX3=8mm|VY3=14mm";
  const hole = [[10,10],[12,10],[12,12],[10,12]].map(([x,y], k) => "|WAFFLE.HOLE1.VX" + k + "=" + x + "mm|WAFFLE.HOLE1.VY" + k + "=" + y + "mm").join("");
  const body = "RECORD=ComponentBody|COMPONENT=0|LAYER=MECHANICAL1|BODYPROJECTION=1";
  const source = [pack, component, body + "|IDENTIFIER=Pocket|MODELID=extr|MODEL.MODELTYPE=0|MODEL.EXTRUDED.MINZ=0.4mm|MODEL.EXTRUDED.MAXZ=2.4mm" + outline + hole,
    body + "|MODELID=external|MODEL.MODELTYPE=1|MODEL.FILENAME=models/tray.step|MODEL.2D.X=10mm|MODEL.2D.Y=10mm|MODEL.2D.ROTATION=90|MODEL.3D.ROTZ=90|MODEL.3D.DZ=0.8mm" + outline].join("\r\n");
  const ext = AtriumIO.read("p.PcbDoc", enc.encode(source)), ed = ext.documents[0], ep = projectFor(ext), owner = ed.items.find(i => i.kind === "part");
  const unresolved = S.model(ep, ed, opts);
  assert.equal(unresolved.parts.length, 1); assert.match(unresolved.notes.join(" "), /Unresolved STEP body/);
  const prism = unresolved.parts[0]; assert.equal(prism.side, "Bottom"); assert.equal(prism.body.loops.length, 2);
  near(prism.body.z0, -2.4); near(prism.body.z1, -.4);
  const solid = S.mesh(unresolved).parts.find(p => p.bodyRecord);
  const bounds = V.buildScene({parts: [solid]}).box;
  [8, 9, -2.4, 15, 14, -.4].forEach((n, k) => near(bounds[k], n));
  const justPocket = S.step({...unresolved, board: {...unresolved.board, bodies: []}}, opts);
  const pocket = I.tessellate(justPocket); assert.equal(pocket.stats.solids, 1);
  pocket.bbox.forEach((n,k) => near(n, bounds[k]));
  // The ray through the hole passes through; a ray through its rim hits the real cap.
  const pocketScene = V.buildScene({parts: [solid]});
  assert.equal(V.pick(pocketScene, [11,11,5], [0,0,-1]).point, null);
  assert.ok(V.pick(pocketScene, [9,10,5], [0,0,-1]).point);
  const tray = new Uint8Array(fs.readFileSync(path.join(__dirname, "../fixtures/mcad/tray.step")));
  let reads = 0;
  const choice = path => ({name: "tray.step", altiumPath: path, size: tray.length, async arrayBuffer() { reads++; return tray; }});
  const design = {name: "p.PcbDoc", altiumPath: "boards/p.PcbDoc"}, selected = choice("boards/models/tray.step");
  const paths = ["/models/tray.step", "../models/tray.step", "file:///models/tray.step", "C:\\models\\tray.step"];
  for (const unsafe of paths) {
    ed.bodyModels[0].file = unsafe;
    await AtriumImport.attachBodyModels([ext], [design], [selected], {check() {}}); assert.equal(reads, 0);
  }
  ed.bodyModels[0].file = "models/tray.step";
  await AtriumImport.attachBodyModels([ext], [design], [selected, choice("boards/MODELS/TRAY.STEP")], {check() {}});
  assert.equal(reads, 0, "ambiguous choices cannot silently supply a model");
  await AtriumImport.attachBodyModels([ext], [design], [choice("other/models/tray.step"), selected], {check() {}});
  assert.equal(reads, 1);
  const resolved = S.model(ep, ed, opts), modelBody = resolved.parts.find(p => p.source === "model");
  assert.equal(modelBody.side, "Bottom"); near(modelBody.model.placement.origin[2], .8);
  const combined = S.step({...resolved, board: {...resolved.board, bodies: []}}, opts);
  assert.equal((combined.match(new RegExp("atrium:" + owner.id, "g")) || []).length, 1, "one STEP occurrence owns both bodies");
  const backMesh = I.ensure(combined); assert.ok(backMesh.stats.solids >= 2);
  const nativeMesh = V.buildScene({parts:S.mesh(resolved).parts.filter(p => p.bodyRecord)});
  backMesh.bbox.forEach((v,k) => near(v, nativeMesh.box[k], .001));
  const bodyAscii = AtriumAltiumExport.exportBoard(ep, ed);
  const again = AtriumIO.read(bodyAscii.name, bodyAscii.bytes);
  assert.match(bodyAscii.content, /\|HOLE0VERTEXCOUNT=4\|H0VX0=/);
  assert.match(bodyAscii.content, /\|IDENTIFIER=80,111,99,107,101,116\|/);
  assert.match(bodyAscii.content, /\|MODEL\.NAME=tray\.step\|/);
  assert.equal(again.documents[0].bodyModels[0].file, "models/tray.step");
  assert.match(bodyAscii.diagnostics.join("\n"), /no STEP companion/);
  assert.equal(records(again.documents[0])[0].rings.length, 2);
  const holeBefore = records(ed)[0].rings[1], holeAfter = records(again.documents[0])[0].rings[1];
  holeAfter.forEach((p,k) => p.forEach((v,j) => near(v,holeBefore[k][j],.000003)));
  ed.bodyModels.push({id: "another-source-guid", file: "models/tray.step"});
  owner.bodies3d.push({...owner.bodies3d[1], modelId: "another-source-guid", sourceRecord: "componentbodies6/data#9"});
  await AtriumImport.attachBodyModels([ext], [design], [selected], {check() {}});
  assert.deepEqual(ed.bodyModels[1], {id: "another-source-guid", file: "models/tray.step", assetId: "external"});
  const duplicates = S.model(ep, ed, opts).parts.filter(p => p.model);
  assert.equal(duplicates[0].model.asset, duplicates[1].model.asset);
  assert.equal(duplicates[0].model.data, duplicates[1].model.data);
  assert.equal((await S.buildAsync(ep, ed, opts)).data, S.build(ep, ed, opts).data);
  assert.equal(AtriumAltiumExport.exportProject(ep).files.filter(f => /\.step$/i.test(f.name)).length, 1);
  const collision = JSON.parse(JSON.stringify(ep)), collisionDoc = collision.documents[0];
  const other = {...collisionDoc.bodyModels[0], id: "different-payload", file: "another/TRAY.STEP"};
  other.stepText = other.stepText.replace("Tray.step", "New.step");
  collisionDoc.bodyModels.push(other);
  const bodyOwner = collisionDoc.items.find(i => i.bodies3d);
  bodyOwner.bodies3d.push({...bodyOwner.bodies3d[1], modelId: other.id});
  const collisionFiles = AtriumAltiumExport.exportProject(collision).files;
  const memberNames = collisionFiles.filter(f => /\.step$/i.test(f.name)).map(f => f.name.toLowerCase()).sort();
  assert.deepEqual(memberNames, ["tray-2.step", "tray.step"], "different source payloads retain distinct portable names");
  assert.match(collisionFiles.find(f => /\.PcbDoc$/i.test(f.name)).content, /MODEL\.NAME=TRAY-2\.STEP\|/);
  // A portable library keeps its authored local bodies; two placements use
  // the same source mesh. Footprint assets remain available after native reopen.
  const library = AtriumIO.read("pack.PcbLib", enc.encode(source));
  const libraryFile = {name: "pack.PcbLib", altiumPath: "libraries/pack.PcbLib"};
  const rootModel = choice("models/tray.step");
  await AtriumImport.attachBodyModels([library], [libraryFile], [rootModel, choice("libraries/models/tray.step")], {check() {}});
  assert.ok(!library.library[0].footprint.bodyModels[0].stepText, "two valid relative resolutions are ambiguous");
  await AtriumImport.attachBodyModels([library], [libraryFile], [rootModel], {check() {}});
  const fp = library.library[0].footprint;
  assert.equal(fp.bodies3d.length, 2); assert.ok(fp.bodyModels[0].stepText);
  const placed = A.sheet("pcb", "Placed"), lp = {...A.project("Placed"), documents: [placed], library: library.library};
  placed.outline = [[0, 0], [60, 0], [60, 50], [0, 50]];
  for (const [n, side] of ["Top", "Bottom"].entries()) {
    const part = A.instantiate(lp, library.library[0], [15 + n * 20, 12], n * 90);
    part.layer = side; placed.items.push(part);
  }
  const restored = reopenAltium(lp,{name:"pack.PcbLib",bytes:enc.encode(source)}).project;
  const fromLibrary = S.model(restored, restored.documents[0], {...opts, deferBodyModels: true});
  assert.equal(fromLibrary.parts.length, 4);
  const libModels = fromLibrary.parts.filter(p => p.model);
  assert.equal(libModels[0].model.asset, libModels[1].model.asset);
  assert.deepEqual(new Set(libModels.map(p => p.side)), new Set(["Top", "Bottom"]));
  const libCache = V.meshFor(restored, restored.documents[0], 0, false);
  assert.equal(libCache.pendingBodies.size, 1); await V.loadBodyMeshes(libCache, I);
  assert.equal(V.buildScene(libCache.meshed).parts.length, 4);
  const exportLibrary = AtriumAltiumExport.exportProject(restored);
  assert.equal(exportLibrary.files.filter(f => /\.step$/i.test(f.name)).length, 1);
  const boardFile = exportLibrary.files.find(f => /\.PcbDoc$/i.test(f.name));
  assert.equal(records(AtriumIO.read(boardFile.name, boardFile.bytes).documents[0]).length, 4);
  assert.equal((await S.buildAsync(restored, restored.documents[0], opts)).data, S.build(restored, restored.documents[0], opts).data);
  const broken = {...assets[0], zlib: assets[0].zlib.slice(0, -8) + "AAAAAAAA"};
  assert.throws(() => fmt.stepBytes(broken), /checksum|compressed/i);
  const cancelled = {aborted: true};
  await assert.rejects(() => I.loadAsset(assets[0], {signal: cancelled}), /cancelled/);
  await assert.rejects(() => S.buildAsync(project, doc, opts, cancelled), /cancelled/);
  await checkBodyWorker();
  console.log("PASS Altium 3D bodies: binary and ASCII, native reopen, lazy edit/Undo, supplied assets, bottom-side geometry, holes, STEP assembly.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
