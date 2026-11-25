"use strict";
// Work and latency for an assistant object page and a reviewed transaction, excluding
// file loading, the editor/Undo and IPC. Pass an earlier checkout's app/ for comparison.
const assert = require("node:assert/strict");
const path = require("node:path"), {performance} = require("node:perf_hooks");
const root = path.resolve(__dirname, ".."), app = path.resolve(process.argv[2] || path.join(root, "app"));
for (const file of ["core/model", "library/parts", "core/spatial", "automation/proposal", "core/atrium-api"]) require(path.join(app, file + ".js"));
const tools = require(path.join(app, "../extensions/ai-assistant/tools.js"));
require(path.join(root, "tests/pcb/dense-board.js"));
const median = values => values.sort((a,b) => a-b)[Math.floor(values.length/2)];

async function measure(name, raw) {
  const durations = [], pageDurations = [];
  let work, pageResult;
  for (let pass = 0; pass < 9; pass++) {
    const p = Atrium.validate(structuredClone(raw)), board = p.documents.find(d => d.kind === "pcb");
    let revision = 0, steps = 0;
    const {api} = AtriumAPI.create({project:() => p, documentId:() => board.id, revision:() => revision,
      edit(fn) { fn(); steps++; revision++; }}, {extension:{id:"benchmark", permissions:{"read:project":true, "propose:edits":true}},
      approve:({rows}) => rows.map(r => r.index)});
    const start = performance.now();
    try {
      const result = await tools.execute(api, "list_objects", {document_id:board.id, offset:50, limit:25}, {});
      assert.equal(result.data.items.length, 25); assert.equal(result.data.total, board.items.length); pageResult = "25 rows";
    } catch (err) { if (!/limit and offset/.test(err.message)) throw err; pageResult = "over API limit"; }
    if (pass >= 2) pageDurations.push(performance.now()-start);

    const tracks = board.items.filter(i => i.kind === "track").slice(0, 194);
    const json = JSON.stringify, validate = Atrium.validate;
    work = {documentCopies:0, projectCopies:0, fullValidations:0};
    JSON.stringify = function(value, ...args) {
      if (Array.isArray(value?.documents)) work.projectCopies++;
      if (Array.isArray(value?.items) && value.kind === "pcb") work.documentCopies++;
      return json.call(this, value, ...args);
    };
    Atrium.validate = function(value, ...args) {
      if (value.documents?.includes(board) || value.name === p.name) work.fullValidations++;
      return validate.call(this,value,...args);
    };
    try {
      const t = performance.now();
      const result = await api.transaction("Widen selected tracks", tx => {
        for (const track of tracks) tx.update(track.id, {width:track.width+0.125});
      });
      if (pass >= 2) durations.push(performance.now()-t);
      assert.equal(result.applied,tracks.length); assert.equal(steps,1);
    } finally { JSON.stringify = json; Atrium.validate = validate; }
  }
  console.log(JSON.stringify({design:name, boardObjects:raw.documents.find(d => d.kind === "pcb").items.length, page:pageResult,
    pageMedianMs:+median(pageDurations).toFixed(2), transactionMedianMs:+median(durations).toFixed(2), ...work}));
}
(async()=>{
  const {d} = makeAtriumBenchmarkBoard(), dense = Atrium.project("Dense", AtriumParts.catalogue);
  dense.documents = [d]; await measure("Dense signal board",dense);
  const imported = require("../tests/support/public-pidp.cjs").publicPiDP(app);
  await measure("PiDP-11 I/O Expander",imported);
})().catch(e=>{console.error(e);process.exitCode=1;});
