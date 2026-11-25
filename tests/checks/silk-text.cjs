"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const module of ["model", "pcb-appearance", "pcb-text", "vectorize", "pcb-text-rich", "designator-place", "pcb/mask-openings", "rules", "query-exchange", "nav-common", "drc-view"])
  require(appFile(module + ".js"));

require("../support/drc-geometry.cjs");
const R = AtriumRules, scope = source => AtriumQueryExchange.fromAltium(source, {layer: name => name === "Top Overlay" ? "Silk" : name}).scope;
const ink = (id, text, fields = {}) => ({kind: "label", id, text, x: 0, y: 0, size: 6, width: .2, layer: "Silk", ...fields});
const pad = (id, x, y, fields = {}) => ({kind: "pad", id, x, y, w: .2, h: .2, drill: 0, shape: "circle", layer: "Top", maskExpansion: 0, ...fields});
const board = (items, fields = {}) => ({kind: "pcb", items, ...fields});
const rules = R.create();
const silk = rules.list.find(rule => rule.type === "silkToMask");
Object.assign(silk, {scope: scope("IsText"), gap: .2, exposedCopper: false});
const findings = (b, defs = new Map(), project) => R.drc(b, defs, rules, {types: ["silkToMask"], scopes: true, project});
const hits = result => result.violations.map(v => [v.id, v.otherId]).sort();
const close = (actual, want) => assert.ok(Math.abs(actual - want) < 1e-6, actual + " differs from " + want);

// An O touches the leg beside one pad. The hole, the gap between the two
// characters, and the opposite film do not contain ink. All strokes of O H
// represent one text primitive for the two-object rule.
const visibleInk = board([
  ink("legend", "O H"),
  pad("near", -.33, -3),
  pad("hole", 2, -3),
  pad("space", 6, -3),
  pad("back", -.33, -3, {layer: "Bottom"}),
  pad("tent", 4, -3, {tent: {top: true}}),
  ink("blank", "  ", {x: 20}),
  pad("under-blank", 20, 0)
]);
let result = findings(visibleInk);
assert.deepEqual(hits(result), [["legend", "near"]]);
close(result.violations[0].actual, .13);
assert.ok(!result.emptyScopes.some(entry => entry.id === silk.id));

// An imported outline rule asks for complete overlay ink. It does not cause
// the existing line-to-mask pass and the text-to-mask pass to count the same line.
{
  const combined = R.create();
  const mask = combined.list.find(rule => rule.type === "silkToMask");
  Object.assign(mask, {gap: .2, exposedCopper: false});
  combined.list.push({id:"imported-edge",type:"boardOutlineClearance",name:"Imported edge",enabled:true,priority:1,
    scope:AtriumDesignQueryRecord.selector("all"),includeOverlay:true,gap:.25});
  const track = {id:"overlay-track",kind:"graphic",layer:"Silk",width:.2,points:[[-.8,4],[-.8,6]]};
  const outline = [[-1,-10],[25,-10],[25,10],[-1,10]];
  const doc = board([...visibleInk.items, track, pad("track-pad", -.7, 5)], {outline});
  const both = R.drc(doc, new Map(), combined, {types:["silkToMask","boardOutlineClearance"]});
  assert.ok(both.violations.some(v => v.type === "boardOutlineClearance" && v.id === track.id));
  assert.deepEqual(hits({violations:both.violations.filter(v => v.type === "silkToMask")}),
    [["legend","near"],["overlay-track","track-pad"]]);
}

// Headless outline clearance uses the fine physical arc even without Board Shape.
{
  const outlineRules=R.create(), arc={kind:"arc",c:[4,4],r:3.81,start:48.65,end:139.1,ccw:true};
  const graphic={kind:"graphic",id:"close-arc",layer:"Silk",width:.2,arc,points:Atrium.arcProjection(arc)};
  outlineRules.list.push({id:"outline-arc",type:"boardOutlineClearance",name:"Outline arc",enabled:true,priority:1,
    scope:AtriumDesignQueryRecord.selector("all"),includeOverlay:true,gap:.091});
  const oldBoardShape=globalThis.AtriumBoardShape;
  try {
    globalThis.AtriumBoardShape=undefined;
    const {violations}=R.drc(board([graphic],{outline:[[0,0],[0,11],[12,11],[12,0]]}),new Map(),outlineRules,{types:["boardOutlineClearance"]});
    assert.deepEqual(violations.map(v=>v.id),["close-arc"]);
    assert.ok(Math.abs(violations[0].actual-.09)<1e-5,"the true arc is .09 mm from the edge");
  } finally { globalThis.AtriumBoardShape=oldBoardShape; }
}

// Ordinary traced and filled legend geometry shares its physical edges with
// the resolved film while the outline check keeps its established default pen.
{
  const outlineRules=R.create();
  outlineRules.list.push({id:"polygonal-ink",type:"boardOutlineClearance",name:"Polygonal overlay",enabled:true,priority:1,
    scope:AtriumDesignQueryRecord.selector("all"),includeOverlay:true,gap:.34});
  const shape=(id,points,extra={})=>({id,kind:"graphic",layer:"Silk",points,...extra});
  const polygon=(x,y)=>[[x,y],[x+.6,y],[x+.6,y+1],[x,y+1]];
  const items=[
    shape("trace",[[4,.38],[6,.38]],{width:.2}),
    shape("default-pen",[[8,.41],[9,.41]]),
    shape("filled",polygon(.29,2),{fill:true}),
    shape("outlined-fill",polygon(.41,4),{fill:true,strokeOutline:true,width:.22}),
    shape("keepout",polygon(.02,6),{fill:true,keepout:true}),
    {id:"rotated-overlay",kind:"part",def:"overlay",ref:"U1",x:1,y:8,angle:90,layer:"Bottom",showRef:false}
  ];
  const defs=new Map([["overlay",{id:"overlay",footprint:{pads:[],shapes:[
    {kind:"path",layer:"Bottom silk",width:.2,points:[[0,.65],[2,.65]]}
  ]}}]]);
  const doc=board(items,{outline:[[0,0],[20,0],[20,20],[0,20]]});
  const result=R.drc(doc,defs,outlineRules,{types:["boardOutlineClearance"]});
  assert.deepEqual(result.violations.map(v=>v.id).sort(),["default-pen","filled","outlined-fill","rotated-overlay","trace"]);
  for(const [id,gap] of [["trace",.28],["default-pen",.32],["filled",.29],["outlined-fill",.30],["rotated-overlay",.25]])
    close(result.violations.find(v=>v.id===id).actual,gap);
}

// The native contour owns the optional outline stroke even when its stored
// display polygon does not sample the extreme of the curve.
{
  require(appFile("board-shape.js"));
  const outlineRules=R.create(), arc={kind:"arc",c:[1.35,5],r:1,start:45,end:45,ccw:true};
  const points=Atrium.arcProjection(arc,90).slice(0,-1);
  const region={kind:"graphic",id:"curved-region",layer:"Silk",width:.4,fill:true,points,strokeOutline:true,
    regionShape:{version:1,contour:[arc],cutouts:[],sig:AtriumBoardShape.signature(points)}};
  outlineRules.list.push({id:"outline-region",type:"boardOutlineClearance",name:"Curved overlay region",enabled:true,priority:1,
    scope:AtriumDesignQueryRecord.selector("all"),includeOverlay:true,gap:.2});
  const outline=[[0,0],[0,10],[10,10],[10,0]], check=item=>
    R.drc(board([item],{outline}),new Map(),outlineRules,{types:["boardOutlineClearance"]}).violations;
  const violations=check(region);
  assert.deepEqual(violations.map(v=>v.id),[region.id]);
  assert.ok(Math.abs(violations[0].actual-.15)<1e-5,"the native outline's centreline is .35 mm from the edge");
  assert.deepEqual(check({...region,strokeOutline:false}),[],"the unoutlined region is .35 mm from the edge");
}

// The legacy graphical clearance pass still measures the 24-facet projection.
{
  const strokeRules=R.create(), mask=strokeRules.list.find(rule=>rule.type==="silkToMask");
  Object.assign(mask,{gap:.13,exposedCopper:false});
  const part={kind:"part",id:"ring",def:"ring",ref:"U1",x:5,y:5,showRef:false};
  const defs=new Map([["ring",{id:"ring",footprint:{pads:[],shapes:[{kind:"circle",x:0,y:0,r:1,width:.2,style:"silk"}]}}]]);
  const doc=board([part,pad("opening",6.25,5,{w:.1,h:.1})]);
  const result=R.drc(doc,defs,strokeRules,{types:["silkToMask"]});
  assert.equal(result.stats.silk,24);
  assert.deepEqual(hits(result),[["ring","opening"]]);
  close(result.violations[0].actual,.1);
}

// Zero stroke width uses the plotter's default width, including its round caps.
// A negative expansion changes the radius of a round mask aperture.
result = findings(board([ink("default-width", "L", {width: 0}), pad("opened", -.93, -3, {w: .8, h: .8, maskExpansion: -.1})]));
assert.deepEqual(hits(result), [["default-width", "opened"]]);
close(result.violations[0].actual, .13);

// On a square land, an expanded mask reaches a corner differently from a
// constant offset of the copper outline. Exposed copper still uses the land.
const surface = board([ink("corner", "I", {angle: 180}), pad("square", -3.8, 6.8, {shape: "rect", w: 1, h: 1, maskExpansion: .2})]);
result = findings(surface);
assert.deepEqual(hits(result), [["corner", "square"]]);
close(result.violations[0].actual, Math.SQRT2 * .1 - .1);
silk.exposedCopper = true;
assert.deepEqual(hits(findings(surface)), []);
delete silk.exposedCopper;
result = findings(surface);
close(result.violations[0].actual, Math.SQRT2 * .3 - .1 - .2);
silk.exposedCopper = false;

// Distinct pin apertures on the same component keep distinct identities.
const footprintPads = new Map([["two-pads", {id: "two-pads", footprint: {
  shapes: [], pads: [pad("local-a", 0, -3, {number: "1"}), pad("local-b", 4, -3, {number: "2"})]
}}]]);
const hiddenRef = {kind: "part", id: "both-pads", def: "two-pads", ref: "U1", showRef: false, x: 0, y: 0};
result = findings(board([ink("one-label", "O"), hiddenRef]), footprintPads);
assert.equal(result.violations.length, 2);
assert.deepEqual(new Set(result.violations.map(v => v.subject.legendPrimitive)), new Set(["label/pad:0", "label/pad:1"]));

// The component's own annotation rules and local frame determine printed ink.
// Bottom text mirrors by layer before the component rotates 90 degrees.
const defs = new Map([["part", {id: "part", footprint: {pads: [], shapes: []}}]]);
const annotations = [
  {field: "ref", at: [0, 0], angle: 0, size: 6, width: .2, layer: "Bottom silk"},
  {field: "value", at: [10, 0], angle: 0, size: 6, width: .2, layer: "Bottom silk"}
];
const part = {kind: "part", id: "owner", def: "part", ref: "O", value: "H", x: 20, y: 20, angle: 90, layer: "Bottom", boardLabels: annotations, showValue: false};
const placements = [
  pad("reference", 23, 15.8, {layer: "Bottom"}),
  pad("reference-unmirrored", 23, 24, {layer: "Bottom"}),
  pad("reference-other-face", 23, 15.8),
  pad("comment", 23, 25.8, {layer: "Bottom"})
];
assert.deepEqual(hits(findings(board([part, ...placements]), defs)), [["owner", "reference"]]);
assert.deepEqual(hits(findings(board([{...part, showValue: true, showRef: false}, ...placements]), defs)), [["owner", "comment"]]);

// Component placeholders, managed references, and project values all use
// the legend they actually print.
const alternate = new Map([["part", {id: "part", footprint: {
  pads: [], shapes: [{kind: "text", text: ".Comment", x: 0, y: 0, size: 6, width: .2, style: "silk"}]
}}]]);
const plainPart = {kind: "part", id: "part-owner", def: "part", ref: "R1", value: "L", x: 40, y: 40, showRef: false};
assert.deepEqual(hits(findings(board([plainPart, pad("printed-comment", 40, 37)]), alternate)), [["part-owner", "printed-comment"]]);
const managed = {...plainPart, ref: "L", showRef: true, designator: {x: 0, y: 0, angle: 0, height: 6}};
result = findings(board([managed, pad("printed-ref", 38, 40)]), defs);
assert.deepEqual(hits(result), [["part-owner", "printed-ref"]]);
assert.equal(result.violations[0].subject.legendPrimitive, "reference");
assert.deepEqual(hits(findings(board([{...managed, showRef: false}, pad("printed-ref", 38, 40)]), defs)), []);
assert.deepEqual(hits(findings(board([ink("parameter", ".Legend"), pad("resolved", 0, -3)]), defs,
  {parameters: {Legend: "L"}})), [["parameter", "resolved"]]);

// A filled glyph has ink strictly inside its outline but a clear counter.
AtriumPCBText.setGlyphSource({
  available: () => true, metrics: () => ({cap: 1, descent: 0, cell: 1}), advance: (_font, text) => text.length,
  glyph: () => [{outer: [[0, -1], [1, -1], [1, 0], [0, 0]],
    holes: [[[.25, -.75], [.25, -.25], [.75, -.25], [.75, -.75]]]}]
});
result = findings(board([
  ink("filled", "O", {font: "truetype", family: "Test font"}),
  pad("in-counter", 3, -3),
  pad("counter-edge", 1.7, -3),
  pad("in-ink", .75, -3)
]));
assert.deepEqual(hits(result), [["filled", "counter-edge"], ["filled", "in-ink"]]);
close(result.violations.find(v => v.otherId === "counter-edge").actual, .1);
close(result.violations.find(v => v.otherId === "in-ink").actual, 0);

// Only the land for the film on this face can contribute. A concave
// custom land cannot intersect ink in the empty part of its bounding box.
const top = ink("top", "L", {x: 30}), bottom = ink("bottom", "L", {x: 32, layer: "Bottom silk"});
result = findings(board([top, bottom, pad("stack", 31, -3, {
  w: 4, h: 1, drill: .25, shape: "rect", layer: "Multi", stackMode: "tmb",
  padStack: {Top: {w: 1, h: 1}, Bottom: {w: 4, h: 1}}
})]));
assert.deepEqual(hits(result), [["bottom", "stack"]]);
const profile = {w: 4, h: 4, shape: "custom", poly: [[-2,-2],[2,-2],[2,-1],[-1,-1],[-1,2],[-2,2]]};
result = findings(board([
  ink("custom-notch", "-", {x: 20, y: 20, size: 1}),
  ink("custom-arm", "-", {x: 18.3, y: 20, size: 1}),
  pad("custom", 20, 20, profile)
]));
assert.deepEqual(hits(result), [["custom-arm", "custom"]]);

// Scope stays attached to the legend primitive, rather than to its parent,
// and the higher-priority rule determines the threshold.
const special = {...silk, id: "scoped-legend", name: "Scoped legend", priority: 1, gap: .12,
  scope: scope("IsText And OnLayer('Top Overlay')")};
silk.priority = 2;
rules.list.push(special);
assert.deepEqual(hits(findings(visibleInk)), []);
special.gap = .14;
result = findings(visibleInk);
assert.deepEqual(hits(result), [["legend", "near"]]);
assert.equal(result.violations[0].ruleId, special.id);

// The annotation lies far from its component. A pad edit in that remote
// area still gives online DRC the same neighbourhood as a full rule check.
const remote = {...plainPart, ref: "L", x: 0, y: 0, showRef: true,
  boardLabels: [{field: "ref", at: [100, 0], angle: 0, size: 6, width: .2, layer: "Silk"}]};
const edited = pad("moving-pad", 102, -3);
const updateBoard = board([remote, edited]);
const live = AtriumDRCView.online(), resolver = AtriumResolvedGeometry, receipts = AtriumGeometryReceipts;
let snapshots = 0, bounds = 0;
globalThis.AtriumResolvedGeometry = {...resolver,read(source) {
  assert.equal(source.kind,"snapshot");
  snapshots++;
  return resolver.read(source);
}};
globalThis.AtriumGeometryReceipts = {...receipts,ownerBounds(...args) {
  bounds++;
  return receipts.ownerBounds(...args);
}};
try {
  assert.deepEqual(hits(live.update(updateBoard, defs, rules)), []);
  assert.deepEqual([snapshots,bounds],[1,2],"one detached board supplies both initial bounds");
  edited.x = 100;
  const incremental = live.update(updateBoard, defs, rules);
  assert.equal(incremental.mode, "incremental");
  assert.deepEqual(hits(incremental), hits(findings(updateBoard, defs)));
  assert.deepEqual(hits(incremental), [["part-owner", "moving-pad"]]);
  assert.equal(live.update(updateBoard,defs,rules).mode,"none");
  assert.deepEqual([snapshots,bounds],[2,3],"the edit resolves just the edited owner and an unchanged call resolves nothing");

  delete globalThis.AtriumResolvedGeometry;
  edited.x = 102;
  const cold = live.update(updateBoard,defs,rules);
  assert.equal(cold.why,"geometry unavailable");
  assert.deepEqual(hits(cold),hits(findings(updateBoard,defs)));
} finally {
  globalThis.AtriumResolvedGeometry = resolver;
  globalThis.AtriumGeometryReceipts = receipts;
}

console.log("PASS silk-to-mask uses plotted legend ink and authored per-face apertures");
