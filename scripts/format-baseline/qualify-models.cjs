"use strict";
// node scripts/format-baseline/qualify-models.cjs SNAPSHOT_DIRECTORY REFERENCE_GZIP_ENCODER BASELINE_INPUTS_TSV
// Read the frozen local snapshots. The pinned stock zlib test encoder reads stdin and writes gzip to stdout.
// The report contains only aggregate model counts and byte totals.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {createHash} = require("node:crypto"), {spawnSync} = require("node:child_process"), {gunzipSync} = require("node:zlib");
const [directory, encoder, baselineInputs] = process.argv.slice(2);
if (!directory || !encoder || !baselineInputs) throw Error("Supply the frozen snapshot directory, stock gzip reference executable, and pinned input TSV.");
for (const name of ["core/zip", "project/source-file", "formats/sexpr", "vendor/zipjs-deflate", "formats/format-2-models"]) require("../../app/" + name + ".js");
const digest = data => createHash("sha256").update(data).digest("hex");
const rows = fs.readFileSync(baselineInputs, "utf8").trimEnd().split(/\r?\n/);
const columns = rows.shift().split("\t");

function* modelBytes(value, body = false) {
  if (Array.isArray(value)) {
    for (const child of value) yield* modelBytes(child, body);
  } else if (value && typeof value === "object") {
    if ((body && typeof value.zlib === "string") || typeof value.stepText === "string") yield AtriumImportFormats.stepBytes(value);
    for (const [key, child] of Object.entries(value)) if (key !== "zlib" && key !== "stepText") yield* modelBytes(child, key === "bodyModels");
  }
}
let total = 0;
for (const row of rows) {
  const fields = row.split("\t"), metadata = Object.fromEntries(columns.map((key, i) => [key, fields[i]]));
  const base = path.join(directory, metadata.case), snapshot = fs.readFileSync(base + ".waffle");
  const receipt = JSON.parse(fs.readFileSync(base + ".input.json", "utf8")), hash = digest(snapshot);
  assert.equal(hash, receipt.sha256, "frozen snapshot receipt");
  if (metadata.snapshot_sha256) assert.equal(hash, metadata.snapshot_sha256, "published snapshot digest");
  assert.equal(snapshot.length, Number(metadata.file_bytes));
  const seen = new Set();
  let uncompressed = 0, stored = 0;
  for (const bytes of modelBytes(JSON.parse(snapshot))) {
    const sha256 = digest(bytes);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const candidate = Buffer.from(AtriumFormat2Models.encode(bytes));
    const reference = spawnSync(encoder, [], {input: bytes, maxBuffer: 40 * 1048576});
    if (reference.error || reference.status !== 0) throw Error("The stock reference encoder failed.");
    assert.ok(candidate.equals(reference.stdout), "complete gzip differs from the stock reference");
    const decoded = AtriumFormat2Models.decode(candidate, {sha256, byteLength: bytes.length});
    assert.ok(Buffer.from(decoded).equals(bytes), "native format readback differs from original bytes");
    assert.ok(gunzipSync(candidate, {maxOutputLength: 32 * 1048576}).equals(bytes), "independent gzip readback differs");
    uncompressed += bytes.length; stored += candidate.length;
  }
  total += seen.size;
  console.log([metadata.case, seen.size, uncompressed, stored].join("\t"));
}
assert.equal(total, 120, "distinct model payloads counted per frozen project");
