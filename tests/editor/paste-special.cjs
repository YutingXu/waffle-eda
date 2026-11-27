"use strict";
// Paste Special, Paste Array and the rubber stamp's plan (paste-special.js) on schematics
// and boards: designator modes, label increment, keep-net-names and array spacing.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "edit-selection", "sch-place", "paste-special"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, ES = AtriumEditSelection, PS = AtriumPasteSpecial;
const R = AtriumParts.catalogue.find(d => d.id === "std-r");
const defsFor = p => new Map(p.library.map(d => [d.id, d]));
function setup() {
  const p = A.project("PS", AtriumParts.catalogue), sch = p.documents[0], pcb = p.documents[1];
  const r = {...A.instantiate(p, R, [10, 10]), ref:"R1"}; sch.items.push(r);
  const w = {id:A.id(), kind:"wire", points:[[0, 0], [5, 0]]}; sch.items.push(w);
  const lab = {id:A.id(), kind:"netlabel", x:5, y:0, text:"D0"}; sch.items.push(lab);
  const clip = ES.capture(sch, defsFor(p), new Set([r.id, w.id, lab.id]));
  return {p, sch, pcb, r, clip};
}
const parts = doc => doc.items.filter(i => i.kind === "part").map(i => i.ref);

// 1. Paste Special: re-annotate (default), keep, increment; labels keep or step.
{
  const {p, sch, clip} = setup();
  let plan = PS.build(p, sch, clip, defsFor(p), {});
  plan.commit([50, 0]);
  assert.deepEqual(parts(sch), ["R1", "R2"], "re-annotate takes the next free designator");
  assert.deepEqual(sch.items.filter(i => i.kind === "netlabel").map(i => i.text), ["D0", "D0"], "labels keep their names by default");
  plan = PS.build(p, sch, clip, defsFor(p), {designators:"keep", labels:"increment"});
  plan.commit([0, 50]);
  assert.deepEqual(parts(sch), ["R1", "R2", "R1"], "keep designators");
  assert.equal(sch.items.filter(i => i.kind === "netlabel").at(-1).text, "D1", "label stepped once");
  const ids = new Set(sch.items.map(i => i.id)); assert.equal(ids.size, sch.items.length, "every pasted object has a fresh id");
  A.validate(A.clone(p));
}

// 2. Paste Array: count, spacing and text increment; one commit adds every copy.
{
  const {p, sch, clip, r} = setup();
  const plan = PS.build(p, sch, clip, defsFor(p), {count:4, dx:20, dy:0, designators:"increment", labels:"increment", step:1});
  assert.equal(plan.copies, 4); assert.equal(plan.items.length, 12);
  const ids = plan.commit([0, 40]);
  assert.equal(ids.length, 12);
  const copies = sch.items.filter(i => i.kind === "part" && i.id !== r.id);
  assert.deepEqual(copies.map(i => i.ref), ["R2", "R3", "R4", "R5"], "R1 steps to R2…R5");
  assert.deepEqual(copies.map(i => i.x), [0, 20, 40, 60], "copies sit at the X spacing from the click");
  assert.ok(copies.every(i => i.y === 40));
  assert.deepEqual(sch.items.filter(i => i.kind === "netlabel").map(i => i.text), ["D0", "D1", "D2", "D3", "D4"]);
  // A step of 2 skips names and moves on past used designators.
  const plan2 = PS.build(p, sch, clip, defsFor(p), {count:2, dx:0, dy:10, designators:"increment", step:2});
  plan2.commit([0, 80]);
  assert.deepEqual(parts(sch).slice(-2), ["R7", "R9"], "R3 and R5 are taken, so each copy steps on by 2 to a free one");
  A.validate(A.clone(p));
}

// 3. Boards: keep net names (on by default) or clear them.
{
  const p = A.project("PCB", AtriumParts.catalogue), pcb = p.documents[1];
  const t = {id:A.id(), kind:"track", points:[[0, 0], [5, 0]], width:.25, layer:"Top", net:"VCC"};
  const via = {id:A.id(), kind:"via", x:5, y:0, diameter:.6, drill:.3, layer:"Multi", net:"VCC"};
  pcb.items.push(t, via);
  const clip = ES.capture(pcb, defsFor(p), new Set([t.id, via.id]));
  PS.build(p, pcb, clip, defsFor(p), {}).commit([10, 0]);
  assert.deepEqual(pcb.items.map(i => i.net), ["VCC", "VCC", "VCC", "VCC"], "paste keeps nets");
  PS.build(p, pcb, clip, defsFor(p), {keepNets:false, count:2, dx:0, dy:5}).commit([20, 0]);
  assert.deepEqual(pcb.items.slice(4).map(i => i.net), ["", "", "", ""], "keep net names off clears them");
  A.validate(A.clone(p));
}

// 4. Errors: empty clipboard, and the cut clipboard pastes fresh copies.
{
  const {p, sch, clip} = setup();
  assert.throws(() => PS.build(p, sch, null, defsFor(p), {}), /Copy or cut/);
  const cut = {...clip, cut:true}; sch.items = sch.items.filter(i => !clip.items.some(c => c.id === i.id));
  const plan = PS.build(p, sch, cut, defsFor(p), {count:2, dx:10});
  plan.commit([0, 0]);
  assert.equal(new Set(sch.items.map(i => i.id)).size, 6, "two copies of a cut, each with its own ids");
}
// 5. Image markups sit in their image's coordinates: an array moves each image copy, never a markup
//    (no x/y to step), and a text markup's plain-string richText pastes with notebook features on.
{
  for (const m of ["note-fields", "notebook"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const p = A.project("Images", AtriumParts.catalogue), sch = p.documents[0];
  const photo = {id:"photo", kind:"image", x:6, y:9, w:8, h:5, src:"data:image/png;base64,iVBORw0KGgo="};
  const box = {id:"box", kind:"imageMarkup", imageId:"photo", shape:"box", at:[100000, 100000], to:[400000, 400000], width:4000, colour:"#aa3344"};
  const note = {...box, id:"note", shape:"text", richText:"Check the rail"};
  sch.items.push(photo, box, note);
  const clip = ES.capture(sch, defsFor(p), new Set(["photo", "box", "note"]));
  PS.build(p, sch, clip, defsFor(p), {count:3, dx:20, dy:0}).commit([0, 0]);
  const images = sch.items.filter(i => i.kind === "image"), marks = sch.items.filter(i => i.kind === "imageMarkup");
  assert.deepEqual(images.slice(1).map(i => i.x), [0, 20, 40], "each image copy steps by the spacing");
  assert.equal(marks.length, 8);
  assert.ok(marks.every(m => !("x" in m) && !("y" in m)), "no markup gains a position");
  assert.deepEqual(marks.slice(2).map(m => m.imageId), images.slice(1).flatMap(i => [i.id, i.id]), "each copy marks its own image");
  assert.deepEqual(marks.filter(m => m.shape === "text").map(m => m.richText), Array(4).fill("Check the rail"));
  A.validate(A.clone(p));
  // Moving a markup by itself leaves it where its image puts it.
  A.moveItem(box, 5, 5); assert.ok(!("x" in box));
}
console.log("PASS paste-special: designator modes, labels, arrays, keep-net-names and image markups");
