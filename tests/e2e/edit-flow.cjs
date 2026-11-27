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
// stdin: {root, out, survey:true, original} for the survey, else
//        {root, out, fixture:{id}, stage, original:{name, path}, native:{dir, manifest},
//         saved:[{target, files:[{name, path}], error?, written:[names found in the output folder]}],
//         touched:{refs:[], nets:[], moved:[{from:[x, y], to:[x, y]}]}, refuse:{target: pattern}, mutation?}
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
const near = (row, at) => Math.hypot(row.v[0] - at[0], row.v[1] - at[1]) <= 0.01;
// May this row differ between the original and the saved file? `lost` is a row of the original.
//   a footprint's pads and graphics   when an edit moved, turned, flipped or added that footprint
//   free copper that moved            only at the place an edit took it from, or put it
//   new free copper                   on a net an edit routed
function attributable(row, touched, lost) {
  if (row.ref && !FREE.has(row.ref)) {
    const ref = row.ref.toUpperCase(), dot = ref.lastIndexOf(".");
    return touched.refs.has(ref) || dot > 0 && touched.refs.has(ref.slice(0, dot));
  }
  if (touched.moved.some(m => near(row, lost ? m.from : m.to))) return true;
  return !lost && touched.nets.has(row.net || "");
}
function untouchedChecks(prefix, before, after, touched) {
  const out = [];
  for (const kind of Object.keys(before.copper.rows)) {
    if (!after.copper.rows[kind]) continue;
    const m = P.match(before.copper.rows[kind], after.copper.rows[kind]), loose = [];
    // Copper may change only on a footprint or a net an edit touched.
    for (const r of m.missing) if (!attributable(r, touched, true)) loose.push("lost " + P.describe(r));
    for (const r of m.extra) if (!attributable(r, touched, false)) loose.push("new " + P.describe(r));
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
  const pins = signature => signature.split(" ").some(pin => pin.includes(".") && touched.refs.has(pin.slice(0, pin.lastIndexOf("."))));
  const groups = [...nets.missing, ...nets.extra].filter(g => !pins(g)).map(g => "membership changed: " + g.slice(0, 120));
  out.push(check(prefix + ".netlist", !groups.length && !nets.renamed.length, {groups:nets.groups, changed:nets.missing.length + nets.extra.length,
    unattributed:groups.length, renamed:nets.renamed.length}, [...groups, ...nets.renamed.map(n => "renamed " + n)]));
  const ringArea = r => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const outline = Math.abs(ringArea(before.outline) - ringArea(after.outline));
  out.push(check(prefix + ".board", outline <= 0.05 && before.pours === after.pours, {outlineAreaChangeMm2:Math.round(outline * 1000) / 1000, pours:before.pours, savedPours:after.pours}));
  return out;
}

// ------------------------------------------------------------------ identities
// The row matcher compares geometry. These compare what a matched object is: the net of every
// free track, arc and via (an empty net included), and the pad each matched face belongs to.
function identityChecks(prefix, after, model) {
  const waffle = P.waffleCopper(model), nets = [], pads = [];
  let copper = 0;
  for (const kind of ["tracks", "arcs", "vias"]) {
    for (const [s, w] of P.match(after.copper.rows[kind] || [], waffle.rows[kind]).pairs) {
      if (w.ref && w.ref !== "track") continue;  // footprint copper takes its net from the pad it touches
      copper++;
      if ((s.net || "") !== (w.net || "")) nets.push(kind + " " + P.describe(w) + ": " + (w.net || "no net") + " -> " + (s.net || "no net"));
    }
  }
  const faces = P.match(after.copper.rows.pads, waffle.rows.pads).pairs.filter(([, w]) => !/^free pad /.test(w.ref));
  for (const [s, w] of faces) if (s.ref.toUpperCase() !== w.ref.toUpperCase()) pads.push(w.ref + " is saved as " + s.ref);
  return [check(prefix + ".copper-nets", !nets.length, {compared:copper, wrong:nets.length}, nets),
    check(prefix + ".pad-numbers", !pads.length, {compared:faces.length, wrong:pads.length}, pads)];
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
  const plotted = new Set(a.files.filter(f => f.kind === "gerber").map(f => ext(f.name)));
  for (const key of films.keys()) if (/^G(TL|BL|\d+|P\d+)$/.test(key) && !plotted.has(key)) bad.push(key + " exists only in the saved file's outputs");
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
const lastList = (text, name) => { const at = text.lastIndexOf("(" + name + " "); return at < 0 ? null : list(text, name, at); };
const within = (text, span, name, change) => {
  const inner = span && list(text.slice(span[0], span[1]), name, 1);
  if (!inner) return null;
  const at = span[0] + inner[0], body = text.slice(at, span[0] + inner[1]);
  return text.slice(0, at) + change(body) + text.slice(span[0] + inner[1]);
};
const bump = (body, index, by) => { let n = -1; return body.replace(/-?\d+(?:\.\d+)?/g, x => ++n === index ? String(Math.round((+x + by) * 1e6) / 1e6) : x); };
const MUTATIONS = {
  "saved-footprint-shift":text => within(text, list(text, "footprint"), "at", body => bump(body, 0, 0.5)),
  "saved-segment-width":text => within(text, lastList(text, "segment"), "width", body => bump(body, 0, 0.05)),
  "saved-drop-segment":text => { const s = lastList(text, "segment"); return s && text.slice(0, s[0]) + text.slice(s[1]); },
  "saved-track-net":text => within(text, lastList(text, "segment"), "net", () => "(net 0)"),
  // Exchange the numbers of the first two pads of one footprint.
  "saved-pad-swap":text => {
    const pads = [...text.matchAll(/\(pad "([^"]+)" /g)];
    const i = pads.findIndex((m, k) => pads[k + 1] && pads[k + 1][1] !== m[1] && !text.slice(m.index, pads[k + 1].index).includes("(footprint "));
    if (i < 0) return null;
    const a = pads[i], b = pads[i + 1], rename = (m, to) => '(pad "' + to + '" ';
    return text.slice(0, a.index) + rename(a, b[1]) + text.slice(a.index + a[0].length, b.index) + rename(b, a[1]) + text.slice(b.index + b[0].length);
  },
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
  const touched = {refs:new Set((request.touched?.refs || []).map(r => r.toUpperCase())), nets:new Set(request.touched?.nets || []), moved:request.touched?.moved || []};
  const original = {name:request.original.name, bytes:bytesOf(request.original.path)};
  const before = stageOf(stage + ".original-read", () => P.oracleBoard(original), results);
  const model = stageOf(stage + ".native-open", () => nativeModel(request.native), results);
  let mutationApplied = null;
  for (const entry of request.saved) {
    const prefix = stage + "." + entry.target, refusal = request.refuse?.[entry.target];
    if (entry.error != null || refusal) {
      // "Lossless or ask": an edit the format cannot hold is refused in the writer's own words, and nothing is written.
      // Any other error (a crash, a lost process, a refusal for a reason not expected here) is a failed save.
      const written = entry.written || [], named = refusal && entry.error != null && new RegExp(refusal, "i").test(entry.error);
      if (named) results.push(check(prefix + ".refused", !written.length && !entry.files?.length,
        {reason:String(entry.error).slice(0, 200), written:written.length}, written.map(name => "wrote " + name)));
      else if (refusal) results.push(check(prefix + ".refused", false, {expected:refusal, reason:String(entry.error ?? "the save succeeded").slice(0, 200)}));
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
    if (entry.target === "altium-source-copy" && !touched.refs.size && !touched.nets.size && !touched.moved.length) {
      const same = saved.bytes.length === original.bytes.length && saved.bytes.every((b, i) => b === original.bytes[i]);
      results.push(check(prefix + ".bytes", same, {original:original.bytes.length, saved:saved.bytes.length}));
    }
    if (model) stageOf(prefix + ".model", () => {
      // KiCad has no free pads: its writer wraps each one in a footprint of its own, which is not a component.
      const refs = new Set(P.boardOf(model).items.filter(i => i.kind === "part").map(i => String(i.ref).toUpperCase()));
      const wrappers = after.copper.parts.filter(p => !refs.has(p.ref.toUpperCase()));
      if (!sameFormat && wrappers.length && wrappers.length === P.boardOf(model).items.filter(i => i.kind === "pad").length) {
        after.copper.parts = after.copper.parts.filter(p => refs.has(p.ref.toUpperCase()));
        const wrapped = new Set(wrappers.map(p => p.ref.toUpperCase()));
        for (const pins of after.nets.values()) for (const pin of [...pins]) if (wrapped.has(pin.slice(0, pin.lastIndexOf(".")).toUpperCase())) pins.delete(pin);
        results.push(check(prefix + ".free-pads-wrapped", true, {footprints:wrappers.length}, [], false));
      }
      const rows = [];
      try { P.sourceChecks(after, model, request.fixture.id, rows); }
      // A format with no pour for a netted copper region writes it as a zone: the count is its own, not a loss.
      finally { for (const r of rows) results.push({...r, id:prefix + r.id.slice("model".length), gating:r.gating && (sameFormat || r.id !== "model.pours")}); }
    }, results);
    if (model) stageOf(prefix + ".identities", () => results.push(...identityChecks(prefix, after, model)), results);
    if (model && request.outputs !== false) stageOf(prefix + ".outputs", () => results.push(...outputChecks(prefix, model, saved, sameFormat)), results);
  }
  return {id:request.fixture.id, stage, results, mutation:request.mutation || null, mutationApplied};
}
// A survey reads only the original: what its source fixes in place, which the importer does not carry.
fs.writeFileSync(request.out, JSON.stringify(request.survey
  ? {fixed:P.oracleBoard({name:request.original.name, bytes:bytesOf(request.original.path)}).fixed} : run()));
