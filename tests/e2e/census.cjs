"use strict";
// Census: is everything a source file holds accounted for after import?
//
// The end-to-end suite compares what it knows to look for: copper, pads, nets, placement, the
// outline, outputs. A property nobody thought to compare is not in any of those rows, so an
// importer that never reads it passes. The census turns the question round. It starts from the
// source: an independent reader lists every object and every field the file holds (census-<format>.cjs,
// no app code), and each one must then be accounted for in exactly one of three ways:
//
//   held      the imported model holds it (the census locates it there and compares the value);
//   reported  the Import Report says it was approximated or dropped, so the user is told;
//   outside   the census table declares it outside a design's meaning, with a written reason
//             (an editor window position, a cache the tool rebuilds).
//
// Anything else fails, in one of two ways that the rows keep apart:
//
//   lost      the census looked for it and the model does not hold it (or holds another value), and
//             the Import Report says nothing. This is proven.
//   unmapped  the census has no check for this field, so nothing has looked. It may be held, lost or
//             fit for an outside reason; it fails until somebody writes the check or the reason.
//
// A field whose object was not found is counted once, on the object's row; on its own row it is
// "unplaced" and does not fail a second time. The Import Report packs references past the first
// 256 of a kind; census-report.cjs unpacks them, so read the report through it.
//
// A census module exports
//   FIXTURES                    [{id, files:[repository-relative paths], translator?}]
//   census(files)               -> [{kind, id, fields:{name: value}}]   files: [{name, bytes}]
//   account(entries, imported, files) -> [{id, pass, gating, metric, detail}]
// where imported is AtriumTranslators.import's result ({model, report, provenance}). Row ids are
// "<kind>" for the objects of a kind and "<kind>.<field>" for one field of them, with metric
// {source, held, reported, outside, lost, unmapped?, unplaced?} and the first failing ones in detail.
// A row passes when lost and unmapped are both zero.
//
//   node tests/e2e/census.cjs [--verbose] [--json OUT] [--update-known] [--only FORMAT|FIXTURE ...]
// Exit status 1 when a gating row fails that census-known-failures.json does not list, or a listed
// one now passes. --update-known rewrites that list from this run (every fixture; not with --only):
// read the difference before committing it. Prepare app assets first with python3 scripts/prepare-assets.py.
const fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "../..");
require("./modules.cjs").load(root);

// The report reader must unpack a grouped reference, or a board with more than 256 parts reads as
// one that lost the rest. No vendored fixture is that large, so it is checked here.
{
  const got = require("./census-report.cjs").references({references:[{source:{file:"f", object:"a#0"}, id:"x"},
    {source:{file:"f"}, grouped:true, objects:[{prefix:"a#", first:1, last:3, width:0}, "b"], ids:["p", "q", "r", "s"]}]});
  if (got.map(r => r.object + "=" + r.id).join(" ") !== "a#0=x a#1=p a#2=q a#3=r b=s") throw Error("census-report.cjs no longer unpacks grouped report references.");
}

const FORMATS = ["kicad", "altium", "eagle"];
const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const jsonOut = flag("--json"), verbose = args.includes("--verbose") && !!args.splice(args.indexOf("--verbose"), 1);
const update = args.includes("--update-known") && !!args.splice(args.indexOf("--update-known"), 1);
const only = args[0] === "--only" ? new Set(args.slice(1)) : null;
const knownFile = path.join(__dirname, "census-known-failures.json"), knownList = JSON.parse(fs.readFileSync(knownFile, "utf8"));
const known = knownList.failures;
if (update && only) { console.error("--update-known rewrites the whole list; run it without --only."); process.exit(2); }

let status = 0;
const reports = [];
for (const format of FORMATS) {
  const file = path.join(__dirname, "census-" + format + ".cjs");
  if (!fs.existsSync(file)) continue;
  const Census = require(file);
  for (const fixture of Census.FIXTURES) {
    if (only && !only.has(format) && !only.has(fixture.id)) continue;
    const files = fixture.files.map(f => ({name:path.basename(f), bytes:new Uint8Array(fs.readFileSync(path.join(root, f)))}));
    let rows;
    try {
      const imported = AtriumTranslators.import(files, {name:fixture.id, source_rules:"use", ...(fixture.translator ? {translator:fixture.translator} : {})});
      rows = Census.account(Census.census(files), imported, files);
    } catch (error) {
      rows = [{id:"census", pass:false, gating:true, metric:{error:String(error?.stack || error).split("\n").slice(0, 2).join(" | ").slice(0, 300)}, detail:[]}];
    }
    const lines = [];
    let failed = false;
    for (const r of rows) {
      const k = known.find(k => k.fixture === fixture.id && k.check === r.id);
      const tag = !r.gating ? "info" : r.pass ? (k ? "FIXED" : "ok") : k ? "known" : "FAIL";
      if (tag === "FAIL" || tag === "FIXED") failed = true;
      if (tag === "ok" || tag === "known" && !verbose) continue;  // known losses are listed with --verbose
      lines.push("  " + tag.padEnd(5) + " " + r.id.padEnd(44) + " " + JSON.stringify(r.metric).slice(0, 200));
      if (tag === "FAIL" || tag === "known") for (const d of (r.detail || []).slice(0, 4)) lines.push("          " + String(d).slice(0, 200));
      if (tag === "known") lines.push("          known: " + k.bug);
      if (tag === "FIXED") lines.push("          now passes; remove it from tests/e2e/census-known-failures.json");
    }
    const gating = rows.filter(r => r.gating);
    const listed = rows.filter(r => r.gating && !r.pass && known.some(k => k.fixture === fixture.id && k.check === r.id));
    const proven = listed.filter(r => r.metric.lost > 0 || r.metric.error).length;
    console.log((failed ? "FAIL" : "ok  ") + "  " + format + " " + fixture.id + " (" + gating.filter(r => r.pass).length + " of " + gating.length + " accounted for" +
      (listed.length ? "; known: " + proven + " lost, " + (listed.length - proven) + " unmapped" : "") + ")");
    if (lines.length) console.log(lines.join("\n"));
    if (failed) status = 1;
    reports.push({format, id:fixture.id, results:rows});
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(reports, null, 1));
if (update) {
  const count = m => [m.lost ? m.lost + " lost" : "", m.unmapped ? m.unmapped + " unmapped" : ""].filter(Boolean).join(", ") || "failed";
  const failures = reports.flatMap(r => r.results.filter(x => x.gating && !x.pass).map(x => ({fixture:r.id, check:x.id,
    bug:count(x.metric) + (x.metric.source ? " of " + x.metric.source : "") + ". First: " + String((x.detail || [])[0] ?? JSON.stringify(x.metric)).slice(0, 160)})));
  fs.writeFileSync(knownFile, JSON.stringify({...knownList, failures}, null, 1) + "\n");
  console.log("Wrote " + failures.length + " known failures to " + path.relative(root, knownFile) + ".");
  status = 0;
}
process.exitCode = status;
