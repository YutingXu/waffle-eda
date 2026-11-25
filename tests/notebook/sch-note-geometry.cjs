"use strict";

const assert = require("node:assert/strict");
for (const name of ["model", "review-comments", "path-record", "pdf", "print", "sch-note-ink", "sch-note-leader", "sch-note-layer", "sch-note-markup"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const ink = AtriumSchNoteInk, leader = AtriumSchNoteLeader;
const sample = (x, y, pressure) => ({world: [x, y], pressure});
const pen = {brush: "pen", width: 2}, marker = {brush: "highlighter", width: 2};

// A batch or the same sequence of coalesced events produces identical ink.
const samples = [sample(0, 0, .2), sample(1, 2, .6), sample(4, 0, 1), sample(7, 0, .8)];
function stroke(batches) {
  const d = ink.capture("pen", 2);
  for (const batch of batches) d.append(batch);
  return d.finish([sample(8, 0, 0)]);
}
const line = stroke([samples]);
assert.deepEqual(line, stroke(samples.map(s => [s])));
assert.deepEqual(line[0], [0, 0, 51]);
assert.deepEqual(line[1], [1.5, 1, 153], "the middle sample uses its two neighbours for position and pressure");
assert.deepEqual(line.at(-1), [8, 0, 204], "releasing at zero pressure preserves the last active pressure");
const draft = ink.capture("pen", 2); draft.append(samples);
const prefix = draft.points.slice(), tail = draft.append([sample(10, 2, .75)]);
assert.deepEqual(draft.points.slice(0, tail), prefix.slice(0, tail), "wet redraw can reuse the leading geometry");

const straight = ink.capture("mouse", 0.5);
for (let x = 0; x <= 800; x++) straight.append([sample(x, 0, x % 2)]);
assert.deepEqual(straight.finish(), [[0, 0, 128], [800, 0, 128]]);
straight.cancel();
assert.equal(straight.points.length, 2, "a late cancellation cannot erase a committed stroke");
const dab = ink.capture("pen", 2);
dab.append([sample(-3, 4, 0), sample(-3, 4, 1)]);
assert.deepEqual(dab.finish([sample(-3, 4, 0)]), [[-3, 4, 255]]);
const abandoned = ink.capture("touch", 1);
abandoned.append([sample(1, 1, 0.5), sample(2, 3, 0.5)]);
assert.deepEqual(abandoned.tip, [2, 3, 128]);
abandoned.cancel(); assert.equal(abandoned.tip, null); assert.deepEqual(abandoned.points, []);
assert.throws(() => abandoned.finish(), /closed/);

const taper = [[0, 0, 0], [10, 0, 255]];
assert.deepEqual(ink.bounds(taper, pen), [-.25, -1, 11, 1]);
assert.ok(ink.hit(taper, pen, [5, -3], [5, 3], 0), "a fast eraser crossing still hits");
assert.ok(ink.hit(taper, pen, [5, .5], [5, .5], 0), "a stationary tip can be inside a wide stroke");
assert.equal(ink.hit(taper, pen, [1, .55], [1, .55], .1), false, "the thin end uses its actual width");
assert.ok(ink.hit(taper, marker, [1, .55], [1, .55], .1), "the highlighter uses a consistent marker width");
assert.ok(ink.hit(dab.points, pen, [-3, 5.25], [-3, 5.25], .25), "the eraser grazes a dot");
assert.equal(ink.hit(dab.points, pen, [20, 20], [30, 20], 2), false);

const recording = AtriumPDF.recorder(100, 100);
recording.ctx.globalAlpha = .5;
ink.draw(recording.ctx, [[5, 5, 30], [10, 10, 90], [5, 10, 120], [10, 5, 255]], marker, "#22aa33");
assert.equal(recording.list.length, 1, "a self-crossing highlighter emits one vector fill");
assert.equal(recording.list[0].k, "p"); assert.equal(recording.list[0].a, .14);
assert.equal(recording.ctx.globalAlpha, .5, "routing dim or output opacity is restored for the next item");
const pdf = AtriumPDF.document({compress: false}); pdf.page(100, 100, recording.list);
assert.ok(pdf.bytes().length > 500);

// Existing review-anchor lookup stays bound to the original ID when a wire
// moves, disappears or is restored. A broken target retains the authored point.
const doc = Atrium.sheet("schematic", "Review"), defs = new Map();
const target = {id: "wire-1", kind: "wire", points: [[20, 14], [24, 18]]};
doc.items.push(target);
const anchor = {kind: "item", id: target.id, at: [22, 16]}, card = [0, 0, 8, 8];
const view = () => leader.route(card, AtriumReviewComments.locate(doc, defs, {anchor}, new Map(doc.items.map(i => [i.id, i]))));
const right = view();
assert.deepEqual(right, {points: [[8, 4], [14, 4], [14, 16], [20, 16]], broken: false, covered: false});
target.points = [[-14, 6], [-12, 8]];
const left = view(); assert.deepEqual(left.points.at(-1), [-12, 7]); assert.deepEqual(left.points[0], [0, 4]);
doc.items = []; const broken = view();
assert.equal(broken.broken, true); assert.deepEqual(broken.points.at(-1), anchor.at);
doc.items = [target]; assert.deepEqual(view(), left);
assert.deepEqual(leader.route(card, {live: true, at: [3, 3], box: [1, 1, 6, 6]}),
  {points: [], broken: false, covered: true}, "a covered target has no leader through the note");
assert.deepEqual(leader.route(card, {live: true, at: [4, 20], box: null}).points, [[4, 8], [4, 20]]);

const sticky = {kind: "sticky", id: "one"}, inkRecord = {kind: "inkStroke", id: "two"};
const viewState = {hiddenKinds: new Set(["inkStroke"]), minimized: new Set(["one"]), routing: true};
const screen = AtriumSchNoteLayer.policy("screen", {view: viewState});
assert.ok(screen.visible(sticky) && screen.minimized(sticky)); assert.equal(screen.visible(inkRecord), false);
assert.ok(screen.opacity < 1); assert.equal(screen.hit(sticky), false, "a dimmed note does not consume routing clicks");
const hidden = AtriumSchNoteLayer.policy("screen", {view: {...viewState, visible: false, routing: false}});
assert.equal(hidden.visible(sticky), false); assert.equal(hidden.hit(sticky), false);
const printed = AtriumSchNoteLayer.policy("print", {view: viewState, layer: {print: false}, includeNotes: true});
assert.ok(printed.visible(inkRecord)); assert.equal(printed.minimized(sticky), false); assert.equal(printed.opacity, 1);
const child = {kind: "imageMarkup", imageId: "photo-a"};
assert.equal(printed.visibleIn(child), false); assert.equal(printed.visibleIn(child, "photo-b"), false);
assert.ok(printed.visibleIn(child, "photo-a")); assert.equal(printed.visibleIn({kind: "notesLayer"}), false);
assert.ok(printed.visibleIn({kind: "reviewItem", parentId: "list"}, "list")); assert.ok(printed.visibleIn(sticky));
assert.equal(AtriumSchNoteLayer.policy("print", {layer: {print: false}}).visible(sticky), false);
assert.equal(AtriumSchNoteLayer.policy("print", {layer: {print: true}, includeNotes: false}).visible(sticky), false);
assert.ok(AtriumSchNoteLayer.policy("foreign", {layer: {print: false}, view: viewState}).visible(inkRecord));

// The image owner supplies the oriented-source transform and crop. Each
// shape sends the same primitive to screen or to a vector-recording context.
const M = AtriumSchNoteMarkup, mark = {id: "m", imageId: "image", kind: "imageMarkup",
  at: [100000, 200000], to: [900000, 600000], width: 20000, colour: "blue"};
function shape(name, extra = {}) { return {...mark, shape: name, ...extra}; }
for (const type of ["box", "ellipse"]) {
  assert.ok(M.hit(shape(type), [500000, 200000]));
  assert.equal(M.hit(shape(type), [500000, 400000]), false, "the empty middle of an outline is unmarked");
}
assert.ok(M.hit(shape("ellipse", {at: [900000, 600000], to: [100000, 200000]}), [895000, 400000]));
const arrow = shape("arrow", {at: [0, 0], to: [100, 0], width: 4});
assert.ok(M.hit(arrow, [88, 4])); assert.equal(M.hit(arrow, [93, 10]), false);
assert.ok(M.hit(shape("text"), [500000, 400000])); assert.ok(M.hit(shape("highlight"), [500000, 400000]));
assert.deepEqual(M.bounds(shape("highlight", {points: [[50, 50, 128]], width: 4})), [48, 48, 52, 52]);
const image = AtriumPDF.recorder(100, 100);
image.ctx.save(); image.ctx.beginPath(); image.ctx.rect(10, 10, 60, 60); image.ctx.clip();
image.ctx.scale(.0001, .0001);
for (const type of ["arrow", "ellipse", "box", "highlight", "text"]) {
  const count = image.list.length;
  M.draw(image.ctx, shape(type), {colour: "#408060", drawText(ctx) { ctx.font = "20000px Helvetica"; ctx.fillText("Reference", 100000, 300000); }});
  assert.ok(image.list.length > count); assert.ok(image.list.slice(count).every(op => op.clip));
}
image.ctx.restore();
assert.equal(image.list.filter(op => op.k === "t" && op.s === "Reference").length, 1);
assert.throws(() => M.draw(image.ctx, shape("text"), {colour: "#111111"}), /text renderer/);
console.log("PASS pressure capture, swept erasure, Notes-layer filters, live callouts and five clipped vector image markup shapes");
