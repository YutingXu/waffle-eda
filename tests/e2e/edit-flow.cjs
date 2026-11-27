"use strict";
// Edit flow, checking side: one checkpoint of one project, in its own Node process
// (tests/e2e/edit-flow.py starts it after driving the MCP server).
//
// The server has imported a foreign design into a native project, edited it and saved it back
// into foreign files. This file never trusts Waffle to read its own output. For every saved file:
//   untouched  the original and the saved file, both read by the independent oracle, differ
//              only in the objects the edits touched (with no edits: not at all);
//   model      the saved file read by the oracle against the edited native project;
//   outputs    fabrication outputs of the saved file (imported again) against those of the
//              edited native project.
// The comparisons are pipeline.cjs's: the same neutral rows, matcher and tolerances.
//
// stdin: {root, out, fixture:{id}, stage, original:{name, path}, native:{dir, manifest},
//         saved:[{target, files:[{name, path}], error?}], touched:{refs:[], nets:[]},
//         refuse:{target: pattern}, mutation?}
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
require(path.join(request.root, "tests/e2e/modules.cjs")).load(request.root);
const P = require("./pipeline.cjs");
const C = require("../formats/gerber-compare.cjs");
const Raster = require("../altium-fidelity/raster.cjs");
const {TOL, check} = P;

const BOARD = /\.(pcbdoc|kicad_pcb)$/i;
const bytesOf = file => new Uint8Array(fs.readFileSync(file));
const stageOf = (name, fn, results) => {
  try { return fn(); }
  catch (error) { results.push(check(name, false, {error:String(error?.stack || error).split("\n").slice(0, 2).join(" | ").slice(0, 300)})); }
};

// The edited native project as the hosts plot it: opened by the verified folder reader.
function nativeModel({dir, manifest}) {
  const members = new Map();
  (function walk(folder, prefix) {
    for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) { if (!/-outputs$/.test(entry.name) && !/^\.waffle\/(local|journal)$/.test(relative)) walk(path.join(folder, entry.name), relative + "/"); }
      else members.set(relative, bytesOf(path.join(folder, entry.name)));
    }
  })(dir, "");
  const opened = P._native.open({manifest, members}, b => new Uint8Array(zlib.gunzipSync(b)));
  return Atrium.validate(AtriumTranslatorProvenance.toLegacy(opened, opened.manufacturing));
}

// ------------------------------------------------------------------ untouched objects
// Free copper carries one of these in place of a component designator.
const FREE = new Set(["track", "segment", "arc"]);
function attributable(row, touched) {
  if (row.ref && !FREE.has(row.ref)) return touched.refs.has(row.ref.toUpperCase()) || touched.refs.has(row.ref.slice(0, row.ref.lastIndexOf(".")).toUpperCase());
  return touched.nets.has(row.net || "");
}
function untouchedChecks(prefix, before, after, touched) {
  const out = [];
  for (const kind of Object.keys(before.copper.rows)) {
    if (!after.copper.rows[kind]) continue;
    const m = P.match(before.copper.rows[kind], after.copper.rows[kind]), loose = [];
    // Copper may change only on a footprint or a net an edit touched.
    for (const r of m.missing) if (!attributable(r, touched)) loose.push("lost " + P.describe(r));
    for (const r of m.extra) if (!attributable(r, touched)) loose.push("new " + P.describe(r));
    out.push(check(prefix + "." + kind, !loose.length, {original:before.copper.rows[kind].length, saved:after.copper.rows[kind].length,
      changed:m.missing.length + m.extra.length, unattributed:loose.length}, loose));
  }
  const was = new Map(before.copper.parts.map(p => [p.ref.toUpperCase(), p])), now = new Map(after.copper.parts.map(p => [p.ref.toUpperCase(), p])), strays = [];
  let moved = 0;
  for (const [ref, p] of new Map([...was, ...now])) {
    const a = was.get(ref), b = now.get(ref);
    if (a && b && Math.hypot(a.x - b.x, a.y - b.y) <= TOL.mm && Math.abs(P.mod(a.angle - b.angle + 180, 360) - 180) <= TOL.deg && a.side === b.side) continue;
    moved++;
    if (!touched.refs.has(ref)) strays.push((a ? b ? "moved " : "lost " : "new ") + p.ref);
  }
  out.push(check(prefix + ".placement", !strays.length, {original:was.size, saved:now.size, changed:moved, unattributed:strays.length}, strays));
  const nets = P.compareNets(before.nets, after.nets);
  const pins = signature => signature.split(" ").some(pin => touched.refs.has(pin.slice(0, pin.lastIndexOf("."))));
  const groups = [...nets.missing, ...nets.extra].filter(g => !pins(g)).map(g => "membership changed: " + g.slice(0, 120));
  out.push(check(prefix + ".netlist", !groups.length && !nets.renamed.length, {groups:nets.groups, changed:nets.missing.length + nets.extra.length,
    unattributed:groups.length, renamed:nets.renamed.length}, [...groups, ...nets.renamed.map(n => "renamed " + n)]));
  const ringArea = r => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const outline = Math.abs(ringArea(before.outline) - ringArea(after.outline));
  out.push(check(prefix + ".board", outline <= 0.05 && before.pours === after.pours, {outlineAreaChangeMm2:Math.round(outline * 1000) / 1000, pours:before.pours, savedPours:after.pours}));
  return out;
}

// ------------------------------------------------------------------ outputs
function outputChecks(prefix, model, saved, sameFormat) {
  const fixture = {...request.fixture, origin:"auto"};
  const reread = AtriumTranslators.import([saved], {name:request.fixture.id, source_rules:"use"});
  const again = Atrium.validate(AtriumTranslatorProvenance.toLegacy(reread.model, reread.provenance));
  const a = P.generate(model, fixture, undefined).fab, b = P.generate(again, fixture, undefined).fab;
  const ext = name => (/\.([^.]+)$/.exec(name)?.[1] || "").toUpperCase(), out = [];
  const films = new Map(b.files.filter(f => f.kind === "gerber").map(f => [ext(f.name), f.content])), layers = {}, bad = [];
  for (const f of a.files.filter(f => f.kind === "gerber")) {
    const key = ext(f.name), copper = /^G(TL|BL|\d+|P\d+)$/.test(key), mask = /^G(TS|BS|TP|BP)$/.test(key);
    if (!films.has(key)) { if (copper) bad.push(key + " is missing from the saved file's outputs"); continue; }
    let xor;
    try { xor = Raster.compare(C.parseGerber(f.content), C.parseGerber(films.get(key))).xorMm2; } catch (error) { xor = null; }
    layers[key] = xor == null ? null : Math.round(xor * 1000) / 1000;
    // A different format has its own mask and paste rules; its copper must still agree.
    const gate = copper ? TOL.xorCopperMm2 : mask && sameFormat ? TOL.xorMaskMm2 : null;
    if (gate != null && !(xor <= gate)) bad.push(key + " differs by " + (xor == null ? "an unreadable film" : xor.toFixed(3) + " mm2"));
  }
  out.push(check(prefix + ".films", !bad.length, {xorMm2:layers, differing:bad.length}, bad));
  const drills = fab => fab.files.filter(f => f.kind === "drill").reduce((all, f) => { const p = C.parseExcellon(f.content); for (const k of ["hits", "slots", "warnings"]) all[k].push(...p[k]); return all; }, {hits:[], slots:[], warnings:[]});
  const d = C.compareDrills(drills(a), drills(b), TOL.drillMm);
  out.push(check(prefix + ".drill", !d.missing.length && !d.extra.length && !d.wrong.length && d.slots.ref === d.slots.out,
    {hits:d.ref, missing:d.missing.length, extra:d.extra.length, wrongSize:d.wrong.length, slots:d.slots.ref, savedSlots:d.slots.out},
    [...d.missing.slice(0, 3).map(h => "missing " + JSON.stringify(h)), ...d.extra.slice(0, 3).map(h => "extra " + JSON.stringify(h))]));
  const table = fab => new Map(P.placementTable(fab.files.find(f => f.kind === "pnp")?.content || "").map(r => [r.ref, r]));
  const want = table(a), have = table(b), wrong = [];
  for (const [ref, r] of want) {
    const o = have.get(ref);
    if (!o) { wrong.push("missing " + ref); continue; }
    const dist = Math.hypot(o.x - r.x, o.y - r.y), rot = Math.abs(P.mod(o.rot - r.rot + 180, 360) - 180);
    if (dist > TOL.placeMm || rot > TOL.rotDeg || o.side !== r.side) wrong.push(ref + " " + dist.toFixed(3) + " mm " + rot.toFixed(2) + " deg " + r.side + "/" + o.side);
  }
  const freePads = P.boardOf(model).items.filter(i => i.kind === "pad").length, extra = [...have.keys()].filter(ref => !want.has(ref));
  if (sameFormat || extra.length !== freePads) for (const ref of extra) wrong.push("extra " + ref);  // else: free pads in their KiCad wrappers
  out.push(check(prefix + ".pnp", !wrong.length, {parts:want.size, saved:have.size, wrong:wrong.length}, wrong));
  return out;
}

// ------------------------------------------------------------------ mutations
// Each damages the saved KiCad board the way a writer bug would; the checks must turn red.
function list(text, name, from = 0) {
  const start = text.indexOf("(" + name + " ", from);
  if (start < 0) return null;
  let depth = 0, quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === "\\") i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")" && !--depth) return [start, i + 1];
  }
  return null;
}
const within = (text, span, name, change) => {
  const inner = span && list(text.slice(span[0], span[1]), name, 1);
  if (!inner) return null;
  const at = span[0] + inner[0], body = text.slice(at, span[0] + inner[1]);
  return text.slice(0, at) + change(body) + text.slice(span[0] + inner[1]);
};
const bump = (body, index, by) => { let n = -1; return body.replace(/-?\d+(?:\.\d+)?/g, x => ++n === index ? String(Math.round((+x + by) * 1e6) / 1e6) : x); };
const MUTATIONS = {
  "saved-footprint-shift":text => within(text, list(text, "footprint"), "at", body => bump(body, 0, 0.5)),
  "saved-segment-width":text => within(text, list(text, "segment"), "width", body => bump(body, 0, 0.05)),
  "saved-drop-segment":text => { const s = list(text, "segment"); return s && text.slice(0, s[0]) + text.slice(s[1]); },
  // Take one pad off a net that joins several pads.
  "saved-pad-net":text => {
    const pads = [...text.matchAll(/\(pad [^\n]*?\(net \d+ "([^"]+)"\)/g)], count = {};
    for (const m of pads) count[m[1]] = (count[m[1]] || 0) + 1;
    const pad = pads.find(m => count[m[1]] > 1);
    if (!pad) return null;
    const at = pad.index + pad[0].lastIndexOf('"' + pad[1] + '"');
    return text.slice(0, at) + '"EDIT_FLOW_MUTATION"' + text.slice(at + pad[1].length + 2);
  },
};

// ------------------------------------------------------------------ checkpoint
function run() {
  const results = [], stage = request.stage;
  const touched = {refs:new Set((request.touched?.refs || []).map(r => r.toUpperCase())), nets:new Set(request.touched?.nets || [])};
  const original = {name:request.original.name, bytes:bytesOf(request.original.path)};
  const before = stageOf(stage + ".original-read", () => P.oracleBoard(original), results);
  const model = stageOf(stage + ".native-open", () => nativeModel(request.native), results);
  let mutationApplied = null;
  for (const entry of request.saved) {
    const prefix = stage + "." + entry.target, refusal = request.refuse?.[entry.target];
    if (entry.error != null || refusal) {
      // "Lossless or ask": an edit the format cannot hold is refused by name, and nothing is written.
      if (refusal) results.push(check(prefix + ".refused", entry.error != null && new RegExp(refusal, "i").test(entry.error) && !entry.files?.length,
        {expected:refusal, files:entry.files?.length || 0, reason:String(entry.error ?? "the save succeeded").slice(0, 200)}));
      else results.push(check(prefix + ".saved", false, {error:String(entry.error).slice(0, 300)}));
      continue;
    }
    const file = entry.files.find(f => BOARD.test(f.name));
    if (!file) { results.push(check(prefix + ".saved", false, {error:"the save wrote no board file", files:entry.files.map(f => f.name)})); continue; }
    const saved = {name:file.name, bytes:bytesOf(file.path)};
    if (request.mutation) {
      const text = /\.kicad_pcb$/i.test(saved.name) && MUTATIONS[request.mutation]?.(new TextDecoder().decode(saved.bytes));
      mutationApplied = !!text || mutationApplied === true;
      if (text) saved.bytes = new TextEncoder().encode(text);
    }
    results.push(check(prefix + ".saved", true, {file:saved.name, bytes:saved.bytes.length}));
    const after = stageOf(prefix + ".oracle-read", () => P.oracleBoard(saved), results);
    if (!after) continue;
    const sameFormat = before && before.kicad === after.kicad;
    if (sameFormat) stageOf(prefix + ".untouched", () => results.push(...untouchedChecks(prefix + ".untouched", before, after, touched)), results);
    if (entry.target === "altium-source-copy" && !touched.refs.size && !touched.nets.size) {
      const same = saved.bytes.length === original.bytes.length && saved.bytes.every((b, i) => b === original.bytes[i]);
      results.push(check(prefix + ".bytes", same, {original:original.bytes.length, saved:saved.bytes.length}));
    }
    if (model) stageOf(prefix + ".model", () => {
      // KiCad has no free pads: its writer wraps each one in a footprint of its own, which is not a component.
      const refs = new Set(P.boardOf(model).items.filter(i => i.kind === "part").map(i => String(i.ref).toUpperCase()));
      const wrappers = after.copper.parts.filter(p => !refs.has(p.ref.toUpperCase()));
      if (!sameFormat && wrappers.length && wrappers.length === P.boardOf(model).items.filter(i => i.kind === "pad").length) {
        after.copper.parts = after.copper.parts.filter(p => refs.has(p.ref.toUpperCase()));
        results.push(check(prefix + ".free-pads-wrapped", true, {footprints:wrappers.length}, [], false));
      }
      for (const r of P.sourceChecks(after, model, request.fixture.id)) results.push({...r, id:prefix + r.id.slice("model".length)});
    }, results);
    if (model && request.outputs !== false) stageOf(prefix + ".outputs", () => results.push(...outputChecks(prefix, model, saved, sameFormat)), results);
  }
  return {id:request.fixture.id, stage, results, mutation:request.mutation || null, mutationApplied};
}
fs.writeFileSync(request.out, JSON.stringify(run()));
