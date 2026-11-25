"use strict";
// One project of the full tier, in its own Node process (tests/e2e/run.py starts it).
// stdin: {root, out, fixture, files:[{name, path, role}], translator?, mutation?}
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
require(path.join(request.root, "tests/e2e/modules.cjs")).load(request.root);
const P = require("./pipeline.cjs");

const read = f => fs.readFileSync(f.path);
const byRole = test => request.files.filter(f => test(f.role));

// Minimal ZIP + XLSX reader for shipped BOMs (central directory, stored or deflated members).
function unzip(buf) {
  const out = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw Error("not a zip");
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n--;) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    at += 46 + nameLen + extra + comment;
  }
  return out;
}
function xlsxRows(buf) {
  const z = unzip(buf), text = n => z.get(n)?.toString("utf8") || "";
  const unescape = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  return [...text("xl/worksheets/sheet1.xml").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
    const cells = [];
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] || "")?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] || "")?.[1] ?? "";
      while (cells.length < col) cells.push("");
      cells[col] = /t="s"/.test(c[2]) ? shared[+v] : unescape(v);
    }
    return cells;
  });
}
function csvRows(text) {
  return text.replace(/^﻿/, "").split(/\r?\n/).map(line => (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [])
    .map(c => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, -1));
}

const sources = byRole(r => r === "source").map(f => ({name:f.name, bytes:new Uint8Array(read(f))}));
const gerbers = byRole(r => r.startsWith("gerber:")).map(f => {
  const layer = f.role.slice(7), extension = path.extname(f.name).slice(1).toUpperCase();
  return {key:extension && !/^(GBR|GBX|ART|PHO)$/.test(extension) ? extension : layer === "profile" ? "Edge" : layer, layer, text:read(f).toString("latin1")};
});
const drills = byRole(r => r === "drill").map(f => read(f).toString("latin1"));
const pnpFile = byRole(r => r === "pnp")[0], bomFile = byRole(r => r === "bom")[0];
let bomRows = null;
if (bomFile) bomRows = /\.xlsx$/i.test(bomFile.name) ? xlsxRows(read(bomFile)) : csvRows(read(bomFile).toString("utf8"));
const drcReport = byRole(r => r === "check:drc")[0];
let sourceDrcViolations = null;
if (drcReport) {
  const m = /Violations Detected\s*:?\s*<\/[^>]+>\s*<[^>]+>\s*(\d+)/i.exec(read(drcReport).toString("latin1")) || /Total\s*<\/td>\s*<td[^>]*>\s*(\d+)/i.exec(read(drcReport).toString("latin1"));
  if (m) sourceDrcViolations = +m[1];
}

let mutationApplied = null;
const gunzip = b => new Uint8Array(zlib.gunzipSync(b));
const spec = {fixture:request.fixture, translator:request.translator, sources,
  references:{gerbers, drills, pnp:pnpFile && !/\.xlsx$/i.test(pnpFile.name) ? read(pnpFile).toString("utf8") : null, bomRows},
  sourceDrcViolations, gunzip, trace:process.env.WAFFLE_E2E_TRACE ? name => process.stderr.write("stage " + name + "\n") : null};
if (request.mutation && P.SOURCE_MUTATIONS[request.mutation])
  mutationApplied = P.applySourceMutation(request.mutation, file => fs.readFileSync(path.join(request.root, file), "utf8"));
else if (request.mutation) spec.mutate = model => { mutationApplied = P.MUTATIONS[request.mutation](model); };
const report = P.run(spec);
fs.writeFileSync(request.out, JSON.stringify({...report, mutation:request.mutation || null, mutationApplied}));
