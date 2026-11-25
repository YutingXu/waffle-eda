"use strict";

// Imported stored copper is verified under the rules it was poured with, scoped rules included.
// A scoped rule ("in class", "in pair", an xSignal class) is compiled by AtriumDesignQuery, which
// the browser loads on demand. A verdict taken without it reads the scope as matching nothing: the
// copper was signed fresh, the compiler loaded later, and the same unchanged board turned stale.
// Connectivity then dropped every pour (GND showed as unrouted) until a repour, started by the
// next edit, replaced the source copper. Until the compiler is present the copper is unverified
// (never "fresh" by default), the compiler is requested, and the verdict after it loads is final.
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "impedance",
  "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "design-query-record",
  "query", "net-intent", "signals", "rules", "viastack", "polygon-pour", "net-ties", "connectivity"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {board} = require("../support/stitched-ground.cjs");

const P = AtriumPolygonPour, C = AtriumConnectivity, compiler = globalThis.AtriumDesignQuery;
assert.ok(compiler, "the scoped-rule compiler is loaded with the rules");
const gnd = r => r.nets.find(n => n.name === "GND");

// The scoped rule decides how the pour joins the ground vias, so it is part of the copper's inputs.
{
  const {project, doc, defs} = board();
  const signed = JSON.stringify(P.polygonSignatures(doc, defs, {project}));
  delete globalThis.AtriumDesignQuery;
  try {assert.notEqual(JSON.stringify(P.polygonSignatures(doc, defs, {project})), signed, "the fixture's copper depends on its scoped rule");}
  finally {globalThis.AtriumDesignQuery = compiler;}
}

(async () => {
  // Imported artwork: tagged source regions without links, adopted on first inspection.
  const {project, doc, defs} = board({imported:true});
  assert.equal(doc.pcbDrawing.sourceFill, true);
  let release, requests = 0;
  const loaded = new Promise(resolve => {release = resolve;});
  globalThis.AtriumLazy = {
    needsRuleQuery: book => book.list.some(r => r.enabled !== false && [r.scope, r.scope2].some(s => s && !/^\s*object\s*$/i.test(s.source || ""))),
    need(name) {assert.equal(name, "AtriumDesignQuery"); requests++; return loaded;}
  };
  delete globalThis.AtriumDesignQuery;
  const verdicts = [P.state(doc, defs, {project})];
  assert.equal(verdicts[0], "stale", "without the compiler the stored copper is unverified, not fresh");
  assert.equal(doc.pcbDrawing.sourceFill, true, "nothing is signed under rules that cannot be compiled yet");
  assert.equal(requests, 0, "physical state reads do not load rules");
  assert.equal(P.inspectCopper(doc, defs, {project}).state, "pending");
  const preparing = P.queryReady(doc, {project});
  const concurrent = P.queryReady(doc, {project});
  await null;
  assert.equal(requests, 1, "explicit preparations share one compiler request");
  globalThis.AtriumDesignQuery = compiler;
  release();
  await Promise.all([preparing, concurrent]);
  assert.equal(P.inspectCopper(doc,defs,{project}).reason, "source-adoption");
  assert.equal(P.adopt(doc,defs,{project},false),true);
  verdicts.push(P.state(doc, defs, {project}));
  assert.equal(verdicts[1], "source", "with the compiler the unchanged source copper verifies");
  assert.equal(doc.pcbDrawing.sourceFill, undefined);
  assert.ok(doc.pcbDrawing.pours.every(r => r.source === "altium"), "the source copper is kept, not repoured");
  assert.deepEqual(P.stale(doc, defs, {project}), [], "and it stays fresh");
  const live = C.inspect(doc, defs), full = C.inspectFull(doc, defs);
  assert.equal(gnd(full).missing, 0, "ground is joined by the stored pour");
  assert.deepEqual(live.airwires, full.airwires);
  delete globalThis.AtriumLazy;

  // A real break still shows: the far via leaves the pour.
  const {project:p2, doc:d2, defs:f2} = board();
  assert.equal(P.state(d2, f2, {project:p2}), "source");
  d2.items = d2.items.filter(i => i.id !== "stitch");
  const broken = C.inspectFull(d2, f2);
  assert.equal(gnd(broken).missing, 1, "the oracle sees the break");
  assert.deepEqual(C.inspect(d2, f2).airwires, broken.airwires);
  // Outputs and accepting source rules wait for the compiler too: neither fills nor signs under rules
  // whose scopes cannot be read yet.
  {
    const {project:p3, doc:d3, defs:f3} = board({imported:true});
    let unblock, asked = 0;
    const ready = new Promise(resolve => {unblock = resolve;});
    globalThis.AtriumLazy = {needsRuleQuery: globalThis.AtriumLazy?.needsRuleQuery || (book => book.list.some(r => r.enabled !== false &&
      [r.scope, r.scope2].some(x => x && !/^\s*object\s*$/i.test(x.source || "")))), need() {asked++; return ready;}};
    delete globalThis.AtriumDesignQuery;
    const out = P.outputCopper(d3, f3, {project:p3, solve:false});
    assert.equal(out.state, "pending", "outputs report every pour pending while the compiler loads");
    assert.deepEqual(out.pending.sort(), ["pour-gnd"]);
    assert.throws(() => P.outputCopper(d3, f3, {project:p3}), /still loading/, "and never fill under unreadable rules");
    const signed = JSON.stringify(d3.pcbDrawing), committed = [];
    const r = AtriumRules.adoptSourcePours(d3, p3, f3, () => committed.push(1));
    assert.deepEqual([r, committed.length], [{kept:0, repoured:0}, 1], "accepting source rules commits them but signs nothing yet");
    assert.equal(JSON.stringify(d3.pcbDrawing), signed);
    const settling = P.settle(d3, f3, {project:p3});
    globalThis.AtriumDesignQuery = compiler;
    unblock();
    const settled = await settling;
    assert.equal(settled.state, "pending", "detached settling waits for dependencies without adopting live contours");
    assert.equal(P.outputCopper(d3,f3,{project:p3}).state, "current");
    assert.equal(JSON.stringify(d3.pcbDrawing), signed, "detached output preparation leaves source artwork intact");
    assert.ok(asked >= 1);
    delete globalThis.AtriumLazy;
  }

  // A pour the source left without copper is poured on its own when the source rules are accepted:
  // the later pour around it keeps the source's copper (it was repoured as "affected" before).
  {
    const R = AtriumRules, {project:p4, doc:d4, defs:f4} = board({imported:true, barePour:true});
    assert.ok(P.adopt(d4,f4,{project:p4},false));
    assert.equal(P.state(d4, f4, {project:p4}), "source");
    const gnd = () => JSON.stringify(d4.pcbDrawing.pours.filter(x => x.polygon === "pour-gnd"));
    const kept = gnd();
    const result = R.adoptSourcePours(d4, p4, f4, () => {
      const set = R.migrate(R.stored(d4, p4));
      for (const x of set.list) if (x.type === "clearance" && x.scope?.source === "object") x.gap = .25;
      R.store(d4, p4, set);
    });
    assert.deepEqual(result, {kept:1, repoured:0}, "the bare pour still fills nothing");
    assert.equal(gnd(), kept, "the ground pour keeps the source copper");
    assert.equal(P.state(d4, f4, {project:p4}), "source");
  }
  console.log("pour-query-compiler: source copper verified only with its scoped rules (" + verdicts.join(" -> ") + "), ground joined, a real break shown, outputs and rule acceptance wait for the compiler, a bare source pour leaves its neighbour's copper OK");
})().catch(error => {console.error(error);process.exitCode = 1;});
