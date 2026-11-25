"use strict";
// Run the very same worker entry used by Project History, with a bounded cache of parsed revisions.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../app");
globalThis.self = globalThis;
const worker = path.join(root, "workers/diff-worker.js");
const load = file => vm.runInThisContext(fs.readFileSync(file, "utf8"), {filename: file});
globalThis.importScripts = (...files) => files.forEach(file => load(path.resolve(path.dirname(worker), file)));
load(worker);
const projects = new Map();
function request(data) {
  let value;
  self.postMessage = reply => { if (reply.error) throw Error(reply.error); value = reply.result; };
  self.onmessage({data});
  return value;
}
function project(side) {
  if (!side) return null;
  if (!projects.has(side.blob)) {
    projects.set(side.blob, request({history: true, project: side}));
    if (projects.size > 3) projects.delete(projects.keys().next().value);
  }
  return projects.get(side.blob);
}
(async () => {
  for await (const line of readline.createInterface({input: process.stdin, crlfDelay: Infinity})) {
    try {
      const {before, after, comparison} = JSON.parse(line);
      const left = project(before), right = project(after);
      if (!globalThis.AtriumHistorySummary) load(path.join(root, "history/project-history-summary.js"));
      if (comparison) {
        const reports = [[left,right],[right,left]].map(([a,b]) => {
          const r = request({before:a,after:b,opts:{}});
          const motion = r.changes.find(c => c.kind === "board.translated");
          return {total:r.summary.total,kinds:r.summary.byKind,components:r.stats.components,
            translation:motion?.translation || null,targets:r.changes.filter(c => c.kind === "library.footprint").flatMap(c => c.target.affected)};
        });
        process.stdout.write(JSON.stringify(reports)+"\n");
        continue;
      }
      const result = AtriumHistorySummary.fromProjects(left, right, 0, true);
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (e) { process.stdout.write(JSON.stringify({error: e.message}) + "\n"); }
  }
})();
