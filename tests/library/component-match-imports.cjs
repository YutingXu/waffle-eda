"use strict";
// Optional local integration test. Pass two previously exported revision directories, each
// containing the project's top-level Altium documents. --ledger adds document/item ordinals
// only. --parity exercises the sliced Compare and Update PCB paths on those same snapshots.
const args = process.argv.slice(2), dirs = args.filter(a => a !== "--ledger" && a !== "--parity");
if (dirs.length === 2) {
  const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
  globalThis.CFB=require("../../app/vendor/cfb.min.js");
  for (const f of ["model","parts","sch-objects","hierarchy","multichannel","board-shape","stackup","polygon-pour","import-link","source-file",
    "altium-ids","sch-import","altium-rules","pcb-pours","pcb-import","io","import-worker-client","diff","eco"]) require(require("../support/app-source-paths.cjs").appFile(f+".js"));
  function read(dir) {
    const files=fs.readdirSync(dir).sort().filter(n=>/\.(prjpcb|schdoc|pcbdoc)$/i.test(n))
      .map(name=>({name,bytes:new Uint8Array(fs.readFileSync(path.join(dir,name)))}));
    assert.ok(files.some(f=>/\.schdoc$/i.test(f.name))&&files.some(f=>/\.pcbdoc$/i.test(f.name)),"Expected schematic and board snapshots");
    const records=files.map(f=>AtriumIO.read(f.name,f.bytes));
    return Atrium.validate(AtriumImport.assemble(records,files,Atrium.project("Revision",AtriumParts.catalogue),null).after);
  }
  function counts(p,kind) {
    return p.documents.filter(d=>d.kind===kind).reduce((n,d)=>n+d.items.filter(i=>i.kind==="part").length,0);
  }
  const before=read(dirs[0]),after=read(dirs[1]),m=AtriumDiff.match(before,after);
  const output={compare:m.componentStats,documents:{},updatePCB:[]};
  const ids=new Set();
  for (const r of m.components.filter(r=>r.after)) {
    assert.ok(!ids.has(r.after),"Multiple matches to a physical object");ids.add(r.after);
    assert.ok(r.confidence>0&&r.confidence<=1&&r.reasons.length);
  }
  for (const kind of ["schematic","pcb"]) {
    const docs=new Set(after.documents.filter(d=>d.kind===kind).map(d=>d.id));
    const entries=m.components.filter(r=>docs.has(r.doc)),pairs=entries.filter(r=>r.after);
    output.documents[kind]={before:counts(before,kind),after:counts(after,kind),exact:pairs.filter(r=>r.confidence===1).length,
      inferred:pairs.filter(r=>!r.review&&r.confidence<1).length,review:pairs.filter(r=>r.review).length,unpairedReview:entries.length-pairs.length,
      added:counts(after,kind)-pairs.length,removed:counts(before,kind)-pairs.length};
  }
  for (const p of [before,after]) {
    const u=AtriumECO.plan(p),n=act=>u.changes.filter(c=>c.action===act).length;
    output.updatePCB.push({matched:u.matches.length,review:u.review.sources.length,new:n("addComponent"),remove:n("removeComponent")});
  }
  if (args.includes("--ledger")) {
    const ordinals = project => {
      const result = new Map(), counts = {schematic: 0, pcb: 0};
      for (const d of project.documents) {
        if (!(d.kind in counts)) continue;
        const doc = (d.kind === "pcb" ? "P" : "S") + ++counts[d.kind];
        d.items.filter(i => i.kind === "part").forEach((p,i) => result.set(p.id, doc + "." + String(i + 1).padStart(2,"0")));
      }
      return result;
    };
    const previous = ordinals(before), next = ordinals(after), rows = new Map(m.components.map(row => [row.before,row]));
    output.ledger = [...previous].map(([id,ordinal]) => {
      const row = rows.get(id);
      return {before: ordinal, after: row?.after ? next.get(row.after) : null,
        status: !row ? "removed" : !row.after ? "unpaired" : row.review ? "proposed" : row.confidence === 1 ? "exact" : "inferred"};
    });
  }
  async function verify() {
    if (args.includes("--parity")) {
      const sliced = await AtriumDiff.compareAsync(before,after,{worker:false});
      assert.deepEqual(sliced.components,m.components);
      assert.deepEqual(sliced.stats.components,m.componentStats);
      for (const p of [before,after]) {
        const sync = AtriumECO.plan(p), background = await AtriumECO.planAsync(p);
        assert.deepEqual(background.matches,sync.matches);
        assert.deepEqual(background.review,sync.review);
      }
      output.parity = "All component correspondences, counts and ECO reviews agree.";
    }
    console.log(JSON.stringify(output,null,2));
  }
  globalThis.__testDone = verify();
} else {
  console.log("Optional Altium revision check: pass two exported snapshot directories to compare them.");
}
