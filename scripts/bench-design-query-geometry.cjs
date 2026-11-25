"use strict";
// node --expose-gc scripts/bench-design-query-geometry.cjs [--quick]
const assert = require("node:assert/strict");
const path = require("node:path");
const quick = process.argv.includes("--quick");
const root = path.resolve(__dirname,"..");
for (const name of ["core/model","library/parts","core/spatial","pcb/board-shape","pcb/viastack","checks/rules","checks/dfa","history/undo-store","checks/design-query-geometry"])
  require(path.join(root,"app",name+".js"));
require(path.join(root,"app/checks/design-query.js"));
require(path.join(root,"tests/pcb/dense-board.js"));

const Q = AtriumDesignQuery, I = AtriumDesignQueryIndex, K = AtriumRules.kit, U = AtriumUndoStore;
const anchorAt = 80 * 160 + 76;
const optionsOf = ({project,doc}, revision = 1) => ({project,documentId:doc.id,revision});
const fixture = () => {
  const {d:doc,defs} = makeAtriumBenchmarkBoard();
  return {project:{id:"dense",documents:[doc],library:[...defs.values()]},doc,defs};
};
const lanes = [
  {name:"top-pad", kind:"pad", limit:5, radius:i => 4+i*.007,
    source:r => "pad on layer Top near R12877 within "+r+" mm"},
  {name:"layer-and-width", kind:"track", limit:24, radius:i => 52+i*.017,
    source:r => "track where near R12877 within "+r+" mm and (on layer Top or on layer Bottom) and width >= 0.22 mm and not width > 0.26 mm"}
];

function oracle(board, kind) {
  const {doc,defs} = board;
  const target = doc.items[anchorAt];
  assert.equal(target.ref,"R12877");
  assert.equal(AtriumDFA.outlineEvidence(defs.get(target.def)).courtyardSource,"courtyard");
  const reviewed = AtriumDFA.record(target,defs,{measure:"courtyard"});
  const surface = K.feature({},reviewed.poly,0);
  const data = K.extract(doc,defs,{physical:true});
  const features = kind === "pad" ? data.pads.filter(f => !f.maskOnly && f.span?.[0] <= 0 && f.span[1] >= 0)
    : data.copper.filter(f => f.kind === "track" && f.width >= .22 && f.width <= .26 &&
      (f.layer === "Top" || f.layer === "Bottom"));
  const distances = new Map();
  for (const f of features) {
    const id = f.parent ? f.parent.id+"/"+(f.item.id || f.pin) : f.id;
    const gap = K.pieceGap(surface,f,Infinity).d;
    distances.set(id,Math.min(gap,distances.get(id) ?? Infinity));
  }
  return radius => [...distances].filter(([,d]) => d <= radius || d-radius <= 1e-12*Math.max(d,radius))
    .map(([id]) => id).sort(I.order);
}

async function request(board,lane,index,expected,revision) {
  const source = lane.source(lane.radius(index)), opts = optionsOf(board,revision), pages = [];
  const cpu = process.cpuUsage(), start = performance.now();
  const ctx = Q.context(board.project,board.doc,opts), compiled = Q.compile(source,ctx);
  assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
  const compileMs = performance.now()-start;
  const prepared = await I.documentIndex(board.project,board.doc,ctx,compiled.plan,opts);
  assert.equal(prepared.diagnostic,undefined,JSON.stringify(prepared.diagnostic));
  const indexedMs = performance.now()-start;
  const result = await compiled.plan.run(prepared,{...opts,limit:lane.limit,onPage(page) {
    pages.push({ms:performance.now()-start,count:page.count,rows:page.rows.map(row=>row.itemId ?? row.id),complete:page.complete});
  }});
  const elapsed = performance.now()-start, usage = process.cpuUsage(cpu);
  assert.equal(result.complete,true,JSON.stringify(result.diagnostic));
  assert.equal(result.count,expected.length,source);
  assert.ok(pages.length >= 2 && !pages[0].complete && pages.at(-1).complete,JSON.stringify(pages));
  assert.equal(pages.at(-1).count,expected.length);
  assert.deepEqual(pages.flatMap(page => page.rows),expected.slice(0,lane.limit));
  return {compile:compileMs, index:indexedMs-compileMs, runToFirst:pages[0].ms-indexedMs,
    first:pages[0].ms, exact:elapsed, cpu:(usage.user+usage.system)/1000,
    checked:result.checked, matches:result.count, firstCount:pages[0].count};
}

async function controls(board,lane,expected) {
  const opts = optionsOf(board), source = lane.source(lane.radius(0));
  assert.equal(Q.countSnapshot(source,opts).complete,false);
  const count = await Q.count(source,opts);
  assert.equal(count.complete,true,JSON.stringify(count.diagnostic));
  assert.equal(count.count,expected.length);
  assert.equal(Q.countSnapshot(source,opts).count,expected.length);
  assert.equal(Q.countSnapshot(source,{...opts,revision:2}).complete,false);

  const grant = {documentIds:new Set([board.doc.id])};
  assert.equal(Q.countSnapshot(source,{...opts,authority:grant}).complete,false);
  assert.equal((await Q.count(source,{...opts,authority:grant})).count,expected.length);
  grant.revoked = true;
  assert.equal(Q.countSnapshot(source,{...opts,authority:grant}).diagnostic.code,"denied");

  const controller = new AbortController();
  const ctx = Q.context(board.project,board.doc,opts), plan = Q.compile(source,ctx).plan;
  const index = await I.documentIndex(board.project,board.doc,ctx,plan,opts);
  let pages = 0;
  const interrupted = await plan.run(index,{...opts,signal:controller.signal,limit:1,onPage() {
    pages++;
    controller.abort();
  }});
  assert.equal(interrupted.diagnostic.code,"cancelled");
  assert.equal(pages,1);
  const cancelled = await plan.run({candidates() { throw Error("Cancelled plan evaluated an index"); }},
    {...opts,signal:controller.signal,onPage() { throw Error("Cancelled plan published a page"); }});
  assert.equal(cancelled.diagnostic.code,"cancelled");

  // The headless permission check must precede access to the document geometry.
  const deniedDoc = {id:"denied",kind:"pcb",get items(){throw Error("Denied query inspected private owners");}};
  const deniedOpts = {project:{id:"denied",documents:[deniedDoc]},documentId:deniedDoc.id,
    revision:1,authority:{documentIds:new Set()}};
  assert.equal((await Q.count(source,deniedOpts)).diagnostic.code,"denied");

  const descriptor = Object.getOwnPropertyDescriptor(globalThis,"AtriumDesignQueryGeometry");
  Object.defineProperty(globalThis,"AtriumDesignQueryGeometry",{configurable:true,get() {
    throw Error("A non-spatial or denied count loaded geometry");
  }});
  try {
    assert.equal((await Q.count(source,deniedOpts)).diagnostic.code,"denied");
    const width = await Q.count("track where width > 1 mm",opts);
    assert.equal(width.complete,true,JSON.stringify(width.diagnostic));
    assert.equal(width.count,0);
  } finally { Object.defineProperty(globalThis,"AtriumDesignQueryGeometry",descriptor); }

  const unmeasured = {id:"elsewhere",kind:"part",ref:"U5",def:"unavailable",x:123,y:45};
  const doc = {id:"small",kind:"pcb",items:[board.doc.items[anchorAt],unmeasured]};
  const unresolvedOpts = {project:{id:"small",documents:[doc],library:board.project.library},documentId:doc.id,revision:1};
  const unknown = await Q.count("part near R12877 within 0 mm",unresolvedOpts);
  assert.equal(unknown.complete,false);
  assert.ok(unknown.diagnostic);
}

async function edits(board,lane,original) {
  const {project,doc} = board, anchor = doc.items[anchorAt], history = [], future = [];
  U.reset(); U.mark(project);
  try {
    await request(board,lane,0,original,1);
    const before = U.mark(project);
    anchor.x += 7.31; anchor.y -= 4.27;
    U.checkpoint(history,future,before,"Move the nearby anchor"); U.record(project,{doc,items:[anchor]});
    const moved = oracle(board,lane.kind)(lane.radius(0));
    assert.notDeepEqual(moved,original);
    await request(board,lane,0,moved,2);
    assert.ok(U.jump(history,future,U.mark(project),-1));
    await request(board,lane,0,original,3);
    assert.ok(U.jump(history,future,U.mark(project),1));
    await request(board,lane,0,moved,4);
  } finally { U.reset(); }
}

function distribution(samples,key) {
  const sorted = samples.map(sample => sample[key]).sort((a,b)=>a-b);
  const percentile = p => +sorted[Math.ceil(p*sorted.length)-1].toFixed(3);
  return {p50:percentile(.5),p95:percentile(.95),min:percentile(1/sorted.length),max:percentile(1)};
}
function summarize(samples) {
  return Object.fromEntries(["compile","index","runToFirst","first","exact","cpu","checked","matches","firstCount"]
    .map(key => [key,distribution(samples,key)]));
}

async function main() {
  const warmRuns = quick ? 2 : 30, coldRuns = quick ? 1 : 10;
  const rows = [];
  for (const lane of lanes) {
    const retained = fixture();
    assert.equal(retained.doc.items.length,25600);
    const expected = oracle(retained,lane.kind);
    const warm = [], cold = [];
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    await request(retained,lane,0,expected(lane.radius(0)));
    for (let i=1; i<=warmRuns; i++) warm.push(await request(retained,lane,i,expected(lane.radius(i))));
    globalThis.gc?.();
    const retainedHeapBytes = process.memoryUsage().heapUsed - before;
    for (let i=0; i<coldRuns; i++) {
      const fresh = fixture();
      globalThis.gc?.();
      cold.push(await request(fresh,lane,i,expected(lane.radius(i))));
    }
    await controls(retained,lane,expected(lane.radius(0)));
    await edits(retained,lane,expected(lane.radius(0)));
    rows.push({name:lane.name,warm:summarize(warm),cold:summarize(cold),retainedHeapBytes,samples:{warm,cold}});
  }
  console.log(JSON.stringify({node:process.version,arch:process.arch,objects:25600,warmRuns,coldRuns,rows},null,2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
