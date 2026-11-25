"use strict";
// One neck-down concept (rules.js neckLength): a Width or Differential Pairs Routing rule's own neck-down length per
// end, else its impedance profile's neck.maxLength, else 2.5 mm; the router and the impedance checks read the same.
// And the differential pair router's auto-shrink stops at the profile's warn window, not at its tolerance.
const assert = require("node:assert/strict");
for (const m of ["model", "rules", "impedance", "stackup", "rigid-flex", "router", "impedance-checks"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, R = AtriumRules, S = AtriumStackup, C = AtriumRouter.core;
const board = () => {
  const b = A.sheet("pcb", "Board"), st = S.preset(4); delete st.derived;
  b.outline = [[0, 0], [40, 0], [40, 20], [0, 20]];
  b.stackup = {...st, impedanceProfiles: [
    {id: "se50", name: "SE 50", type: "single", target: 50, tolerance: 10, window: 5, policy: "fab", neck: {maxLength: 1}, layers: {Top: {enabled: true}}},
    {id: "se50b", name: "SE 50 no neck", type: "single", target: 50, tolerance: 10, policy: "fab", layers: {Top: {enabled: true}}},
    {id: "d100", name: "USB 100", type: "diff", target: 100, tolerance: 10, window: 5, policy: "fab", layers: {Top: {enabled: true, gap: .1}}}]};
  return b;
};
// ---- the resolver
{
  const b = board();
  assert.equal(R.NECK_DEFAULT, 2.5);
  assert.equal(R.neckLength(b, {type: "width"}), 2.5, "the user's default");
  assert.equal(R.neckLength(b, {type: "width", impedanceProfile: "se50"}), 1, "the profile's neck");
  assert.equal(R.neckLength(b, {type: "width", impedanceProfile: "se50b"}), 2.5, "a profile without one: the default");
  assert.equal(R.neckLength(b, {type: "width", impedanceProfile: "se50", neckLength: 3}), 3, "the rule's own, editable");
  // An editable field of both rule types, stored only when set.
  for (const t of ["width", "diffPairsRouting"]) assert.ok(R.types[t].fields.some(f => f.key === "neckLength" && f.optional), t);
  const set = R.create(), w = set.list.find(r => r.type === "width");
  assert.equal("neckLength" in R.normalize(set).list.find(r => r.type === "width"), false, "omitted when blank");
  w.neckLength = 2; R.validate(R.normalize(set));
}
// ---- the router reads the same length
{
  const b = board(), set = R.create(), w = set.list.find(r => r.type === "width");
  const api = () => { b.rules = R.normalize(set); return C.rulesFor(b, {}, null); };
  assert.equal(api().width("SIG", "Top").neck, 2.5);
  w.impedanceProfile = "se50"; assert.equal(api().width("SIG", "Top").neck, 1);
  w.neckLength = 1.8; assert.equal(api().width("SIG", "Top").neck, 1.8);
}
// ---- auto-shrink floor at the warn window
{
  const b = board(), set = R.create(), dp = set.list.find(r => r.type === "diffPairsRouting");
  dp.widthMin = .01; dp.gapMin = .01; dp.impedanceProfile = "d100";
  b.rules = R.normalize(set);
  const v = S.profileValues(b, "d100", "Top"), lim = C.rulesFor(b, {}, null).diffPair("USB_P", "USB_N", "USB", "Top");
  assert.ok(v.warnMinWidth > .01 && v.warnMinGap > .01, "the profile has a warn window");
  assert.ok(lim.minWidth >= v.warnMinWidth - 1e-9, "width floor at the warn window: " + lim.minWidth + " >= " + v.warnMinWidth);
  assert.ok(lim.minGap >= v.warnMinGap - 1e-9, "gap floor at the warn window: " + lim.minGap + " >= " + v.warnMinGap);
  // Without a profile the rule's minimums stay the floor.
  delete dp.impedanceProfile; b.rules = R.normalize(set);
  const bare = C.rulesFor(b, {}, null).diffPair("USB_P", "USB_N", "USB", "Top");
  assert.ok(bare.minGap <= .01 + 1e-9);
}
console.log("neck-shrink ok");
