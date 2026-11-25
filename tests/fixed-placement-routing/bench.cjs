"use strict";
// Offline corpus runner. The router subprocess never receives an authored board.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {execFileSync} = require("node:child_process");
const {entries, confirmation, fixture, read, hash} = require("./sources.cjs");
const {imported, definitions} = require("./runtime.cjs");
const {inventory, strip} = require("./strip.cjs");
const {inspect, summary, delta} = require("./quality.cjs");
const {fit, choose} = require("./learn.cjs");
const {profiles} = require("./profiles.cjs");
const frozen = require("./models.json");

function filledArea(doc) {
  const area={};
  for(const region of doc.pcbDrawing?.pours||[]) {
    const rings=AtriumPCBPours.contours(region);
    let filled=0;
    rings.forEach((ring,j)=>{
      let sum=0;
      for(let i=0,k=ring.length-2;i<ring.length;k=i,i+=2)sum+=ring[k]*ring[i+1]-ring[i]*ring[k+1];
      filled+=(j===0?1:-1)*Math.abs(sum)/2;
    });
    area[region.layer]=(area[region.layer]||0)+filled;
  }
  return Object.fromEntries(Object.entries(area).map(([layer,a])=>[layer,+a.toFixed(3)]));
}

function runWorker(wire, methods, rescue) {
  // A regular input descriptor also works for large placed boards on macOS Node, where the
  // synchronous child-process pipe can stall waiting for EOF. Only the stripped bytes cross it.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-placed-"));
  let fd;
  try {
    const file = path.join(directory,"placement.waffle");
    fs.writeFileSync(file,wire,{flag:"wx",mode:0o600});
    fd = fs.openSync(file,"r");
    const args = [path.join(__dirname,"worker.cjs"),...methods,...(rescue?["--rescue"]:[])];
    return JSON.parse(execFileSync(process.execPath,args,{stdio:[fd,"pipe","inherit"],encoding:"utf8",maxBuffer:64*1024*1024}));
  } finally {
    if(fd!==undefined)fs.closeSync(fd);
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

function measure(entry, methods, rescue = false) {
  const p = imported(read(entry), entry.id), authored = p.documents[0], stripped = strip(p);
  Atrium.validate(stripped);
  const wire = JSON.stringify(stripped);
  const result = runWorker(wire,methods,rescue);
  // Original copper becomes visible only to the reference evaluation, after the independent router exits.
  const defs = definitions(p);
  if (authored.pcbDrawing?.sourceFill === "pour") AtriumPolygonPour.adopt(authored,defs,{project:p});
  const r = inspect(p), b = inspect(stripped), source = fixture(entry);
  const planeNets = [...new Set(authored.items.filter(i=>i.kind==="polygon"&&i.net).map(i=>i.net))].sort();
  const trackedNets = new Set(authored.items.filter(i=>i.kind==="track"&&i.net).map(i=>i.net));
  return {id:entry.id,family:entry.family,revision:source.revision,license:source.license,
    stripSha256:hash(wire),source:inventory(p),reference:{...summary(r,delta(r,b)),pouredNets:planeNets,filledMm2ByLayer:filledArea(authored),
      pourOnlyNets:planeNets.filter(n=>!trackedNets.has(n))},...result};
}

function folds(boards, refit = false) {
  return boards.map(test => {
    // Only public placement features and scores of independently routed TRAINING boards enter fit.
    const training = boards.filter(b=>b.family!==test.family).map(({family,features,runs})=>({family,features,runs}));
    const prefit = frozen.byFamily[test.family] || frozen.unseen;
    const model = refit ? fit(training,test.family) : prefit.model;
    if (model.families.includes(test.family)) throw Error("Training included " + test.family);
    return {id:test.id,excludedFamily:test.family,trainingBoards:refit ? boards.filter(b=>b.family!==test.family).map(b=>b.id) : prefit.trainingBoards,
      choice:choose(model,test.features),model};
  });
}
function main() {
  const arg = (k, fallback) => {const i = process.argv.indexOf(k); return i < 0 ? fallback : process.argv[i+1];};
  const ids = arg("--boards","").split(",").filter(Boolean), methods = arg("--methods","").split(",").filter(Boolean);
  const boards = [], selected = process.argv.includes("--confirmation") ? confirmation : entries;
  for (const b of ids.length ? ids.map(id => {const b=selected.find(v=>v.id===id); if(!b)throw Error("Unknown fixture "+id); return b;}) : selected) {
    process.stderr.write("Routing " + b.id + "\n");
    boards.push(measure(b, methods, process.argv.includes("--rescue")));
  }
  const refit = process.argv.includes("--refit");
  if (refit && (boards.length !== entries.length || !entries.every(e=>boards.some(b=>b.id===e.id)) || !boards.every(b=>profiles.every(q=>b.runs[q.id])))) throw Error("Refit requires the entire original calibration corpus and all profiles");
  const result = {fit:refit ? "refit" : frozen.fitCommit,boards, folds:folds(boards,refit)};
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
}
if (require.main === module) main();
module.exports = {measure,folds};
