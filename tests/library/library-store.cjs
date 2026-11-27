"use strict";
// Library management phase 0: content hashes, readable revisions,
// library health checks, the per-component record layer (sync seam) and the visual update review.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "component-families", "library-store", "library-panel", "library-diff", "footprint-wizard"]) require(require("../support/app-source-paths.cjs").appFile(m));
const A = Atrium, L = AtriumLibrary, S = AtriumLibraryStore, D = AtriumLibraryDiff;
const clone = v => JSON.parse(JSON.stringify(v));

{
  // SHA-256 test vectors (FIPS 180-2) and UTF-8 input.
  assert.equal(S.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(S.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(S.sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(S.sha256("µΩ"), S.sha256(new Uint8Array([0xc2, 0xb5, 0xce, 0xa9])));
  const backing = new Uint8Array([255, 97, 98, 99, 0]);
  assert.equal(S.sha256(backing.subarray(1, 4)), S.sha256("abc"));
  assert.equal(S.sha256(Int16Array.of(256 + 97, 98, 99)), S.sha256("abc"));
  const malformed = "\ud800\ud800\udc00\udc00", supplementary = [0xf0, 0x90, 0x80, 0x80];
  const replacement = [0xef, 0xbf, 0xbd];
  assert.equal(S.sha256(malformed), S.sha256([...replacement, ...supplementary, ...replacement]));
  const encoder = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = undefined;
    assert.equal(S.sha256(malformed), S.sha256([0xed, 0xa0, 0x80, ...supplementary, 0xed, 0xb0, 0x80]));
  } finally { globalThis.TextEncoder = encoder; }
  assert.equal(S.canonical({b: 1, a: [1, {d: 2, c: undefined}]}), '{"a":[1,{"d":2}],"b":1}');
  console.log("PASS SHA-256 vectors and canonical JSON");
}

const p = A.project("Lib", []);
const made = L.createFootprint(p, {family: "chip", preset: "0603"}).def;
made.symbol = {pins: [{number: "1", name: "A", x: -5.08, y: 0, orientation: "left", length: 2.54}, {number: "2", name: "B", x: 5.08, y: 0, orientation: "right", length: 2.54}],
  shapes: [{kind: "path", style: "body", closed: true, points: [[-2.54, -1], [2.54, -1], [2.54, 1], [-2.54, 1]]}]};
made.prefix = "R"; made.value = "10k";

{
  // Content hash: provenance, id and revision are not content; an inline model and the same model
  // in the project's blob table hash alike.
  const a = clone(made), b = {...clone(made), id: "other", rev: 7, libraryRef: {library: "x"}};
  assert.equal(S.contentHash(a), S.contentHash(b));
  assert.notEqual(S.contentHash(a), S.contentHash({...a, value: "4k7"}));
  const step = "ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;\n";
  const inline = {...clone(made), id: "m1", footprint: {...clone(made.footprint), model3d: {file: "r.step", stepText: step, offset: [0, 0, 0], rotation: [0, 0, 0]}}};
  const proj = {library: [clone(inline), {...clone(inline), id: "m2"}], documents: []};
  const h0 = S.contentHash(clone(inline)), s0 = S.sideHash(inline, "footprint");
  assert.equal(S.hoistAll(proj).models, 2);
  const sha = S.sha256(step);
  assert.deepEqual(Object.keys(proj.blobs), [sha], "two copies are stored once");
  assert.deepEqual(Object.keys(proj.library[0].footprint.model3d), ["file", "sha256", "offset", "rotation"], "key order kept");
  assert.equal(S.contentHash(proj.library[0]), h0, "hoisted and inline hash alike");
  assert.equal(S.sideHash(proj.library[0], "footprint"), s0);
  assert.equal(S.stepTextOf(proj, proj.library[1].footprint.model3d), step);
  const back = S.inflate(proj, proj.library[0]);
  assert.deepEqual(back, inline, "inflate gives the inline def back exactly");
  assert.equal(S.unusedBlobs(proj).length, 0);
  delete proj.library[0].footprint.model3d; delete proj.library[1].footprint.model3d;
  assert.equal(S.pruneBlobs(proj), 1); assert.equal(proj.blobs, undefined);
  console.log("PASS content hashes; 3D models stored once, inflated back and pruned");
}
{
  // Health checks: missing 3D, pin/pad mismatch, unmapped pins and pads, duplicate ids and names.
  const good = clone(made);
  const missing = {...clone(made), id: "m", footprint: {...clone(made.footprint), pads: [made.footprint.pads[0]]}};
  const extra = {...clone(made), id: "x", name: made.name, symbol: {...clone(made.symbol), pins: [...made.symbol.pins, {number: "3", name: "C", x: 0, y: 5.08, orientation: "down", length: 2.54}]}};
  const dupId = {...clone(made), name: "Something else"};
  const r = S.health([good, missing, extra, dupId]);
  const codes = r.issues.map(x => x.def + ":" + x.code);
  assert.ok(codes.includes("m:unmapped-pin") && codes.includes("m:count"), codes.join(" "));
  assert.ok(codes.includes("x:unmapped-pin"));
  assert.ok(r.issues.some(x => x.code === "duplicate-id" && x.level === "error"));
  assert.ok(r.issues.some(x => x.code === "duplicate-name"));
  assert.ok(r.issues.some(x => x.code === "no-3d"), "a footprint without a model is reported");
  assert.ok(r.counts.error >= 3);
  assert.ok(r.issues[0].level === "error", "errors first");
  // Cached per object: a second run returns the same per-def results without recomputing.
  assert.deepEqual(S.health([good]).issues, S.health([good]).issues);
  const blobless = {...clone(made), id: "b", footprint: {...clone(made.footprint), model3d: {file: "gone.step", sha256: "0".repeat(64)}}};
  assert.ok(S.health([blobless], {project: {library: [blobless], documents: []}}).issues.some(x => x.code === "missing-3d-data"));
  console.log("PASS health checks: unmapped pins/pads, counts, duplicates, missing 3D and missing blob data");
}
{
  // Records: deterministic serialisation, tombstones and a three-way merge per component.
  const a = S.record({...clone(made), id: "c1"}, {rev: 3}), a2 = S.record({...clone(made), id: "c1", value: "22k"}, {rev: 4});
  assert.equal(a.hash, S.sha256(a.body)); assert.equal(a.rev, 3);
  assert.equal(S.serialise({b: 1, a: {d: [1, 2], c: "x"}}), '{\n  "a": {\n    "c": "x",\n    "d": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n');
  const b = S.record({...clone(made), id: "c2"}), t = S.tombstone("c2", 2, "2026-11-20");
  // Ours edited c1, theirs deleted c2: both apply.
  let m = S.merge([a, b], [a2, b], [a, t]);
  assert.equal(m.records.get("c1"), a2); assert.equal(m.records.get("c2"), t); assert.equal(m.conflicts.length, 0);
  // Both edited c1 differently: a conflict, ours kept.
  const a3 = S.record({...clone(made), id: "c1", value: "47k"}, {rev: 4});
  m = S.merge([a], [a2], [a3]);
  assert.equal(m.conflicts.length, 1); assert.equal(m.records.get("c1"), a2);
  // Same edit on both sides: no conflict.
  m = S.merge([a], [a2], [S.record({...clone(made), id: "c1", value: "22k"}, {rev: 4})]);
  assert.equal(m.conflicts.length, 0);
  console.log("PASS records: deterministic text, tombstones, per-component three-way merge");
}
{
  // Readable revisions: saving a changed def bumps rev; the project copy remembers it; status says rev 1 -> rev 2.
  const proj = A.project("Rev", []);
  const def = clone(made); def.id = "own"; proj.library.push(def);
  const lib = {id: "lab", name: "Lab", defs: []};
  const entry = L.saveToLibrary(lib, def, proj);
  assert.equal(entry.rev, 1); assert.equal(def.libraryRef.rev, 1);
  assert.ok(def.libraryRef.symbol.hash && def.libraryRef.footprint.hash, "per-side fingerprints");
  L.saveToLibrary(lib, def, proj); assert.equal(lib.defs[0].rev, 1, "an unchanged save keeps the revision");
  // The library moves ahead twice.
  const src = lib.defs[0];
  src.footprint.pads[0].x -= .2; src.rev = 3;
  let st = L.libraryStatus(def, [lib]);
  assert.equal(st.state, "update"); assert.equal(st.fromRev, 1); assert.equal(st.toRev, 3);
  assert.match(L.stateText(st), /rev 1 → rev 3/);
  def.value = "1k"; st = L.libraryStatus(def, [lib]); assert.equal(st.state, "diverged");
  def.value = src.value; delete src.rev; src.footprint.pads[0].x += .2; st = L.libraryStatus(def, [lib]); assert.equal(st.state, "current", "rev is not content");
  // The copy a project takes never carries the entry's own rev; libraryRef does.
  src.rev = 5; const copy = L.fromLibrary(lib, src, proj);
  assert.equal(copy.rev, undefined); assert.equal(copy.libraryRef.rev, 5);
  // Tombstones survive the .atrlib round trip.
  lib.tombstones = [{id: "gone", rev: 2, deleted: true, date: "2026-11-20"}];
  const read = L.readLibraryFile(L.libraryFile(lib).text);
  assert.deepEqual(read.tombstones, lib.tombstones); assert.equal(read.defs[0].rev, 5);
  console.log("PASS readable revisions: rev bump on change, rev a → rev b status, per-side hashes, tombstones in .atrlib");
}
{
  // Visual review: structured comparison, impact on placed parts, SVG overlays, partial updates.
  const proj = A.project("Impact", []);
  const def = clone(made); def.id = "res"; proj.library.push(def);
  const sch = proj.documents.find(d => d.kind === "schematic"), pcb = proj.documents.find(d => d.kind === "pcb");
  const r1 = A.instantiate(proj, def, [50.8, 50.8]); r1.ref = "R1"; sch.items.push(r1);
  const r2 = A.instantiate(proj, def, [101.6, 50.8]); r2.ref = "R2"; sch.items.push(r2);
  const pin2 = A.pins(r1, def, "schematic").find(q => q.number === "2").at;
  sch.items.push({id: "w1", kind: "wire", points: [pin2, [pin2[0] + 5.08, pin2[1]]]}, {id: "l1", kind: "netlabel", text: "VOUT", x: pin2[0] + 5.08, y: pin2[1]});
  pcb.items.push({...A.instantiate(proj, def, [10, 10]), ref: "R1", link: r1.link, pinNets: {"1": "GND", "2": "VOUT"}});
  const next = clone(def);
  next.symbol.pins = next.symbol.pins.filter(q => q.number === "1");
  next.symbol.pins.push({number: "3", name: "C", x: 0, y: 5.08, orientation: "down", length: 2.54});
  next.footprint.pads[0].x -= .3; next.footprint.pads[0].w += .1;
  next.parameters = {MPN: "RC0603FR-0710KL"};
  const c = D.compare(def, next);
  assert.deepEqual(c.pins.added.map(q => q.number), ["3"]); assert.deepEqual(c.pins.removed.map(q => q.number), ["2"]);
  assert.deepEqual(c.pads.moved.map(m => m.pad.number), ["1"]); assert.equal(c.pads.resized.length, 1);
  assert.ok(c.params[0].sourcing, "MPN changes are flagged as sourcing");
  const imp = D.impact(proj, def, next);
  assert.deepEqual(imp.designators, ["R1", "R2"]);
  assert.ok(imp.lostNets.some(x => x.ref === "R1" && x.pin === "2" && x.net === "VOUT"), JSON.stringify(imp.lostNets));
  assert.ok(imp.routedPads.some(x => x.ref === "R1" && x.pad === "1"), "a moved pad with a net is listed");
  for (const side of ["symbol", "footprint"]) {
    const svg = D.svg(def, next, side);
    assert.match(svg, /^<svg [^>]*viewBox="[-\d. ]+"/); assert.match(svg, side === "symbol" ? /ld-add[^]*ld-del|ld-del[^]*ld-add/ : /ld-was[^]*ld-mod/);
  }
  // Only R2 takes the library copy; R1 keeps the project copy.
  const lib = {id: "lab", name: "Lab", defs: [{...next, id: "lab-res", rev: 2}]};
  const r = D.applyUpdate(proj, def, lib, lib.defs[0], ["R2"]);
  assert.ok(r.split); assert.equal(r2.def, r.def); assert.equal(r1.def, "res");
  const newDef = proj.library.find(d => d.id === r.def);
  assert.equal(newDef.libraryRef.rev, 2); assert.equal(newDef.rev, undefined);
  // Updating every designator keeps the id.
  const all = D.applyUpdate(proj, def, lib, lib.defs[0]);
  assert.equal(all.def, "res"); assert.equal(proj.library.find(d => d.id === "res").libraryRef.id, "lab-res");
  console.log("PASS update review: pins/pads compared, lost nets and routed pads listed, SVG overlays, update selected designators");
}
{
  // 3D models stored once (format 1.4): a library copy and an edited def are hoisted into project.blobs;
  // status, Save to library and copy/paste between projects still see the model.
  require("../../app/editor/edit-selection.js");
  const step = "ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;\n";
  const withModel = {...clone(made), id: "lib-r", rev: 2, footprint: {...clone(made.footprint), model3d: {file: "r.step", stepText: step, offset: [0, 0, 0], rotation: [0, 0, 0]}}};
  const lib = {id: "lab", name: "Lab", defs: [withModel]};
  const proj = A.project("Blobs", []);
  const copy = L.addFromLibrary(lib, withModel, proj);
  assert.equal(copy.footprint.model3d.sha256, S.sha256(step)); assert.equal(copy.footprint.model3d.stepText, undefined);
  assert.equal(proj.blobs[S.sha256(step)].stepText, step);
  assert.equal(L.libraryStatus(copy, [lib], proj).state, "current", "a hoisted copy still matches the inline library entry");
  // Save to library writes the text inline again.
  const other = {id: "lab2", name: "Lab 2", defs: []};
  const entry = L.saveToLibrary(other, copy, proj);
  assert.equal(entry.footprint.model3d.stepText, step); assert.equal(entry.footprint.model3d.sha256, undefined);
  // replaceDef (editors, wizard, MCP) stores a newly embedded model once.
  const edited = {...clone(copy), footprint: {...clone(copy.footprint), model3d: {file: "b.step", stepText: step + "\n", offset: [0, 0, 0], rotation: [0, 0, 0]}}};
  L.replaceDef(proj, edited);
  assert.ok(proj.library.find(d => d.id === copy.id).footprint.model3d.sha256);
  assert.equal(Object.keys(proj.blobs).length, 2);
  assert.equal(S.pruneBlobs(proj), 1, "the replaced model is no longer used");
  // Copy a placed part into another project: the model travels with the selection.
  const sch = proj.documents.find(d => d.kind === "schematic"), live = proj.library.find(d => d.id === copy.id);
  const part = A.instantiate(proj, live, [10, 10]); sch.items.push(part);
  const defs = new Map(proj.library.map(d => [d.id, d]));
  const clip = AtriumEditSelection.capture(sch, defs, new Set([part.id]), false, proj.blobs);
  assert.deepEqual(Object.keys(clip.blobs), Object.keys(proj.blobs));
  const target = A.project("Target", []), tsch = target.documents.find(d => d.kind === "schematic");
  AtriumEditSelection.prepare(target, tsch, clip, new Map()).commit([0, 0]);
  const pasted = target.library.find(d => d.name === live.name);
  assert.equal(S.stepTextOf(target, pasted.footprint.model3d), step + "\n");
  // A project that already has the definition (but not its model) reuses it and still gets the STEP blob.
  const holder = A.project("Holder", [clone(live)]), hsch = holder.documents.find(d => d.kind === "schematic");
  AtriumEditSelection.prepare(holder, hsch, clip, new Map(holder.library.map(d => [d.id, d]))).commit([0, 0]);
  assert.equal(holder.library.length, 1, "the definition is reused");
  assert.equal(S.stepTextOf(holder, holder.library[0].footprint.model3d), step + "\n", "its STEP blob is pasted too");
  console.log("PASS 3D models stored once: library copies, status, Save to library inline, replaceDef, paste between projects");
}
{
  // AtriumDiff: moving inline models into the table is one short line per model, never the STEP text.
  for (const m of ["sch-objects", "hierarchy", "altium-rules", "pcb-draw", "component-classes", "rules", "diff"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const definition = clone(AtriumParts.catalogue[0]);
  const step = require("node:fs").readFileSync(__dirname + "/../fixtures/mcad/tray.step", "utf8");
  definition.footprint.model3d = {file:"tray.step", stepText:step};
  const before = A.project("Inline and shared model", [definition]);
  const after = clone(before); S.hoistAll(after);
  const r = AtriumDiff.compare(before, after), kinds = r.changes.map(c => c.kind);
  assert.deepEqual(kinds, ["library.model3d"], kinds.join(", "));
  assert.ok(!JSON.stringify(r.changes).includes("ISO-10303"), "no STEP text in the diff");
  console.log("PASS diff: a model stored once is one library.model3d change");
}
