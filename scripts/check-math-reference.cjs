#!/usr/bin/env node
"use strict";

// Check the product parser and layout against pinned source expressions and
// independently measured XeTeX boxes. Only the candidate app loads product code.
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {parseArgs} = require("node:util");

const fixture = path.join(__dirname, "../tests/fixtures/math");
const allowed = {
  advance: {absolute: .10, relative: .08},
  ascent: {absolute: .10, relative: .14},
  descent: {absolute: .10, relative: .14},
};

function corpus() {
  const electronics = fs.readFileSync(path.join(fixture, "electronics.tsv"), "utf8").trim().split(/\r?\n/).slice(1).map(line => {
    const [id, group, mode, title, tex] = line.split("\t");
    return {id, group, display: mode === "display", title, tex};
  });
  const upstream = require(path.join(fixture, "katex-expressions.json")).cases.map(row => ({...row, id: "katex-" + row.id}));
  const all = [...electronics, ...upstream], ids = new Set(all.map(row => row.id));
  assert.equal(electronics.length, 100);
  assert.equal(ids.size, all.length, "The reference fixture repeats an ID.");
  const receipt = require(path.join(fixture, "reference/layout.json"));
  const boxes = new Map(receipt.cases.map(row => [row.id, row]));
  assert.equal(all.filter(row => row.errorAt === undefined).length, boxes.size);
  for (const row of all) {
    const box = boxes.get(row.id);
    if (row.errorAt !== undefined) { assert.equal(box, undefined); continue; }
    assert.ok(box && box.mode === (row.display ? "display" : "inline"));
    if (row.group) {
      const png = fs.readFileSync(path.join(fixture, "reference", box.image));
      assert.equal(createHash("sha256").update(png).digest("hex"), box.sha256);
    }
  }
  return {all, boxes, receipt};
}

function checkParser(cases) {
  let valid = 0, invalid = 0, positions = 0;
  const failures = [];
  for (const row of cases) {
    const result = AtriumMathTex.parse(row.tex);
    if (row.errorAt === undefined) {
      if (!result.errors.length) valid++;
      else failures.push({id: row.id, diagnostics: result.errors});
    } else {
      if (result.errors.length) invalid++;
      if (result.errors.some(e => e.start === row.errorAt)) positions++;
      else failures.push({id: row.id, expectedAt: row.errorAt, diagnostics: result.errors});
    }
  }
  return {valid, invalid, positions, failures};
}

function checkLayout(cases, reference) {
  const misses = [], max = {}, counts = {};
  const fields = Object.keys(allowed);
  let matched = 0, accepted = 0;
  for (const row of cases) {
    const expected = reference.get(row.id);
    if (!expected) continue;
    const layout = AtriumMath.layout(row.tex, {display: row.display});
    if (layout.errors?.length) {
      misses.push({id: row.id, errors: layout.errors});
      continue;
    }
    accepted++;
    let fits = true;
    for (const key of fields) {
      const delta = Math.abs(layout[key] - expected[key]);
      const limit = Math.max(allowed[key].absolute, allowed[key].relative * expected[key]);
      if (Number.isFinite(delta)) max[key] = Math.max(max[key] || 0, delta);
      if (!(delta <= limit)) {
        counts[key] = (counts[key] || 0) + 1;
        fits = false;
        misses.push({id: row.id, axis: key, expected: expected[key], actual: layout[key], tolerance: limit});
      }
    }
    if (fits) matched++;
  }
  return {accepted, matched, max, outsideTolerance: counts, misses};
}

function main() {
  const {values} = parseArgs({options: {
    app: {type: "string"},
    "parser-only": {type: "boolean"},
    "fixtures-only": {type: "boolean"},
    "layout-file": {type: "string", default: "notebook/math.js"},
    details: {type: "string"},
  }});
  const {all, boxes, receipt} = corpus();
  if (values["fixtures-only"]) {
    console.log(JSON.stringify({boxes: boxes.size, images: all.filter(row => row.group).length,
      expectedErrors: all.length - boxes.size, font: receipt.fontSHA256}));
    return;
  }
  const app = path.resolve(values.app || path.join(__dirname, "../app"));
  const load = file => require(path.join(app, file));
  load("notebook/math-tex.js");
  const parser = checkParser(all);
  let layout;
  if (!values["parser-only"]) {
    for (const file of ["vendor/stix-two-math.js", "notebook/math-font.js", values["layout-file"]]) load(file);
    const hash = createHash("sha256").update(Buffer.from(AtriumMathFont.bytes())).digest("hex");
    assert.equal(hash, receipt.fontSHA256, "Candidate and reference fonts differ.");
    layout = checkLayout(all, boxes);
  }
  console.log(JSON.stringify({parser: {...parser, failures: parser.failures.length},
    ...(layout ? {layout: {...layout, misses: layout.misses.length}} : {})}));
  if (values.details) fs.writeFileSync(values.details, JSON.stringify({parser, layout}, null, 2) + "\n");
  if (parser.failures.length || layout?.misses.length) process.exitCode = 1;
}

module.exports = {corpus};
if (require.main === module) main();
