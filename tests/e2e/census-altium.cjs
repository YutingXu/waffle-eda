"use strict";
// Census of Altium binary PcbDoc files (tests/e2e/census.cjs defines the contract).
//
// census() lists every stream of the compound file and every record and field in it, from the file
// alone. It reuses the oracle's container and record readers (altium-oracle.cjs) and loads no app
// code. Text-property streams give every KEY=value. Binary primitive streams give the header the
// oracle documents (layer, the lock and polygon-outline bits, keep-out, net, polygon, component, the
// union index where its offset is known) and the geometry the editor shows; the rest of such a record
// is counted, not decoded. A stream with no known layout is one counted record. Field names keep the
// source's spelling; account() groups indexed keys (VX0, VX1 ...) as VX<n>.
//
// account() then finds each object and field in the imported model (millimetres, Y down; Altium is
// mils, Y up), in the Import Report (report.kinds statuses and the import notes), or in the OUTSIDE
// reasons below. Anything else fails: lost where a comparison here shows the model does not hold it,
// unmapped where this file has no comparison for it. Objects are located from the source geometry,
// not from the importer's ids, except parts, pours and rules, which the report links to their source
// records (report.modelObjects, rule origin.record); their values are then compared here. A primitive
// names its component by record index, and a layer named in record text (MID2, PLANE1) is a slot of
// Altium's fixed layer table that M.layerKey places in the stack.
//
// Two comparisons are weaker than the rest and say so: a part's SOURCEUNIQUEID counts as held when the
// part has a schematic link (the importer hashes the id into it, which the census cannot redo without
// app code), and a rule field with no entry in RULE_ALIASES counts as held when the Waffle rule has an
// equal value under a property that shares a word with the field name.

const O = require("./altium-oracle.cjs");
const {references} = require("./census-report.cjs");

const FIXTURES = [
  {id:"altium-pidp11", files:["tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"]},
  {id:"altium-pairs-xsignals", files:["tests/fixtures/altium/pairs-xsignals/PairsXSignals.PcbDoc"]},
  // planes-qfn/PlanesQfn.PcbDoc and signals-ascii/Signals.PcbDoc are PCB ASCII files (|RECORD=Board|...),
  // not compound files; terminal-drag holds only a SchDoc. None of them is a binary PcbDoc.
];

// ------------------------------------------------------------------ census
const TICK = O.MM, NONE = 0xffff;  // mm per binary unit (1/10000 mil)
const u8s = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const latin1 = u8 => { let s = ""; for (const c of u8) s += String.fromCharCode(c); return s; };
const utf16 = u8 => { let s = ""; for (let i = 0; i + 1 < u8.length; i += 2) { const c = u8[i] | u8[i + 1] << 8; if (!c) break; s += String.fromCharCode(c); } return s; };
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, "0")).join("");

// [u16 prefix]?[u32 length][payload] repeated to the exact end of the stream, or null.
function frames(data, prefix = 0) {
  const out = [], v = dv(data);
  for (let at = 0; at < data.length;) {
    if (at + prefix + 4 > data.length) return null;
    const head = prefix ? v.getUint16(at, true) : null, n = v.getUint32(at + prefix, true);
    at += prefix + 4;
    if (n > data.length - at) return null;
    out.push({head, bytes:data.subarray(at, at + n)}); at += n;
  }
  return out;
}
const isText = rows => rows && rows.length && rows.every(r => /^\|?[A-Z0-9_. ]+=/i.test(latin1(r.bytes.subarray(0, 64))));
function props(bytes) {
  const out = {};
  for (const field of latin1(bytes).replace(/\0+$/, "").split("|")) {
    const eq = field.indexOf("=");
    if (eq > 0) out[field.slice(0, eq).toUpperCase()] = field.slice(eq + 1).replace(/[\r\n]+$/, "");
  }
  return out;
}

// Binary primitive streams: record type and block count, as the oracle and the importer frame them.
const PRIMITIVES = {
  arcs6:[1, 1], pads6:[2, 6], vias6:[3, 1], tracks6:[4, 1], texts6:[5, 2], texts:[5, 2], fills6:[6, 1],
  regions6:[11, 1], shapebasedregions6:[11, 1], boardregions:[11, 1],
  componentbodies6:[12, 1], shapebasedcomponentbodies6:[12, 1],
};
// Union index of a track or an arc: u32 at 36 of a track, at 45 of an arc (the layout
// app/formats/pcb-patch.js checks before it edits one). Regions and bodies carry UNIONINDEX in
// their property text. Pads, vias, texts and fills: the offset is not known, so it is not read.
const UNION_AT = {tracks6:[36, 40], arcs6:[45, 49]};

// Legacy layer numbers, named by stack position as the oracle names copper (Board6 LAYER<id>NEXT chain).
function stackNames(board) {
  const chain = [];
  for (let id = 1, guard = 0; id && guard++ < 64; id = Number(board["LAYER" + id + "NEXT"]) || 0) {
    if (board["LAYER" + id + "NAME"] == null || chain.includes(id)) break;
    chain.push(id);
    if (id === 32) break;
  }
  const complete = chain.at(-1) === 32;
  const pos = new Map(chain.map((id, i) => [id, i === 0 ? "top" : id === 32 ? "bottom" : "mid" + i]));
  return {chain:complete ? chain : [], layerOf:n => (complete && pos.has(n) ? pos.get(n) : O.layerName(n))};
}

function census(files) {
  const entries = [];
  for (const file of files) {
    const s = O.compoundFile(u8s(file.bytes)), named = p => s.names?.get(p) || p;
    const storage = p => named(p).split("/")[0];
    const boardRec = O.textRecords(s.get("board6/data"))[0] || {};
    const {layerOf} = stackNames(boardRec);
    const nets = O.textRecords(s.get("nets6/data")).map(p => p.NAME || "");
    const comps = O.textRecords(s.get("components6/data")).map(p => p.SOURCEDESIGNATOR || "");
    const push = (kind, id, fields, extra = {}) => entries.push({kind, id, fields, extra:{file:file.name, ...extra}});
    const header = g => {
      const v = dv(g), net = v.getUint16(3, true), poly = v.getUint16(5, true), comp = v.getUint16(7, true);
      return {LAYER:layerOf(g[0]), LOCKED:(g[1] & 4) === 0, POLYGONOUTLINE:(g[1] & 2) !== 0, KEEPOUT:g[2] === 2,
        NET:net === NONE ? "" : nets[net] ?? "?" + net, POLYGON:poly === NONE ? null : poly, COMPONENT:comp === NONE ? null : comps[comp] ?? "?" + comp};
    };
    for (const [path, data] of s) {
      const parts = path.split("/"), leaf = parts.at(-1), root = parts[0];
      if (parts.length === 1) {
        // FileHeader (UTF-16 version text); FileHeaderSix (ANSI version text, version double, document GUID).
        const fields = {};
        if (root === "fileheader") fields.TEXT = utf16(data.subarray(4));
        if (root === "fileheadersix" && data.length > 5) {
          const n = data[4]; fields.TEXT = latin1(data.subarray(5, 5 + n));
          if (data.length >= 13 + n) fields.VERSION = dv(data).getFloat64(5 + n, true);
          const m = /\{[0-9A-F-]{36}\}/i.exec(latin1(data)); if (m) fields.GUID = m[0];
        }
        push(named(path), named(path), fields, {bytes:data.length});
        continue;
      }
      const kindBase = storage(path), id = i => named(path) + "#" + i;
      if (leaf === "header") { push(kindBase + "/Header", named(path), {COUNT:data.length >= 4 ? dv(data).getUint32(0, true) : null}); continue; }
      if (leaf !== "data") { push(kindBase + "/<n>", named(path), {}, {bytes:data, stream:path}); continue; }  // Models/<n>: one compressed model each
      if (!data.length) { push(kindBase + "/Data (empty)", named(path), {}); continue; }  // listed, though it holds no record
      if (PRIMITIVES[root]) {
        const [type, count] = PRIMITIVES[root];
        let recs;
        try { recs = O.binaryRecords(data, t => (t === type ? count : 0)); }
        catch (error) { push(kindBase, id(0), {}, {bytes:data.length, unreadable:String(error.message)}); continue; }
        recs.forEach(({blocks}, i) => {
          const g = blocks[type === 2 ? 4 : 0], v = dv(g), f = header(g);
          const L = o => v.getInt32(o, true) * TICK, D = o => v.getFloat64(o, true), owner = v.getUint16(7, true);
          const extra = {bytes:g.length, index:i, comp:owner === NONE ? null : owner};
          if (UNION_AT[root] && g.length >= UNION_AT[root][1]) f.UNIONINDEX = v.getUint32(UNION_AT[root][0], true);
          if (type === 4) Object.assign(f, {X1:L(13), Y1:L(17), X2:L(21), Y2:L(25), WIDTH:L(29)});
          if (type === 1) Object.assign(f, {X:L(13), Y:L(17), RADIUS:L(21), STARTANGLE:D(25), ENDANGLE:D(33), WIDTH:L(41)});
          if (type === 3) Object.assign(f, {X:L(13), Y:L(17), DIAMETER:L(21), HOLESIZE:L(25), STARTLAYER:layerOf(g[29]), ENDLAYER:layerOf(g[30]),
            TESTPOINTTOP:(g[1] & 0x80) !== 0, TESTPOINTBOTTOM:(g[2] & 1) !== 0});
          if (type === 6) Object.assign(f, {X1:L(13), Y1:L(17), X2:L(21), Y2:L(25), ROTATION:D(29)});
          if (type === 2) Object.assign(f, {NAME:latin1(blocks[0].subarray(1, 1 + blocks[0][0])), X:L(13), Y:L(17),
            TOPXSIZE:L(21), TOPYSIZE:L(25), HOLESIZE:L(45), TOPSHAPE:g[49], ROTATION:D(52), PLATED:g[60] !== 0, STACKMODE:g[62],
            TESTPOINTTOP:(g[1] & 0x80) !== 0, TESTPOINTBOTTOM:(g[2] & 1) !== 0});
          // A rounded rectangle is base shape 1 (round) plus the size-and-shape block: 32 alternate
          // shapes at 532 (9 = rounded rectangle) and 32 corner radii at 564 (percent of half the
          // shorter side). Index 0 is the top layer. The block is empty on a pad that needs none.
          // The same block holds the hole: its shape at 262 (0 round, 1 square, 2 slot), the slot's other dimension at 263 and its turn at 267.
          if (type === 2 && blocks[5].length >= 596) { const x = dv(blocks[5]);
            Object.assign(f, {TOPALTSHAPE:blocks[5][532], TOPCORNERRADIUS:blocks[5][564], HOLESHAPE:blocks[5][262], SLOTSIZE:x.getInt32(263, true) * TICK, SLOTROTATION:x.getFloat64(267, true)}); }
          if (type === 5) Object.assign(f, {X:L(13), Y:L(17), HEIGHT:L(21), ROTATION:D(27), MIRROR:g[35] !== 0,
            TEXT:latin1(blocks[1].subarray(1, 1 + blocks[1][0])), COMMENT:g[40] !== 0, DESIGNATOR:g[41] !== 0});
          if (type === 11 || type === 12) {
            // Regions and 3D bodies: the primitive header, then [u32 n][n bytes of KEY=value text] at 18.
            const n = g.length >= 22 ? v.getUint32(18, true) : 0;
            Object.assign(f, props(g.subarray(22, 22 + n)));
            if (type === 11 && g.length >= 26 + n) {
              // Outline: [u32 n] then n (x, y) doubles (Regions6) or n+1 37-byte vertices with int32 x, y (shape-based).
              const at = 22 + n, k = v.getUint32(at, true), shaped = root !== "regions6", box = [Infinity, Infinity, -Infinity, -Infinity];
              for (let j = 0; j < k && at + 4 + (j + 1) * (shaped ? 37 : 16) <= g.length; j++) {
                const o = at + 4 + j * (shaped ? 37 : 16);
                const x = (shaped ? v.getInt32(o + 1, true) : v.getFloat64(o, true)) * TICK, y = (shaped ? v.getInt32(o + 5, true) : v.getFloat64(o + 8, true)) * TICK;
                box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
              }
              extra.box = box; extra.vertices = k; extra.holes = v.getUint16(14, true);
            }
          }
          push(kindBase, id(i), f, extra);
        });
        continue;
      }
      if (root === "rules6") {
        const rows = frames(data, 2);
        if (!rows) { push(kindBase, id(0), {}, {bytes:data.length}); continue; }
        rows.forEach((r, i) => { const p = props(r.bytes); push(kindBase + "/RULEKIND=" + (p.RULEKIND || "?"), id(i), p, {index:i, prefix:r.head}); });
        continue;
      }
      if (root === "widestrings6") {  // [u32 index][u32 byte length][UTF-16 text] repeated
        const v = dv(data);
        for (let at = 0, i = 0; at + 8 <= data.length; i++) {
          const n = v.getUint32(at + 4, true);
          push(kindBase, id(i), {INDEX:v.getUint32(at, true), TEXT:utf16(data.subarray(at + 8, at + 8 + n))}); at += 8 + n;
        }
        continue;
      }
      if (root === "unionnames") {  // [u32 count] then [u32 union index][u32 byte length][UTF-16 name] per union
        const v = dv(data), n = data.length >= 4 ? v.getUint32(0, true) : 0;
        for (let at = 4, i = 0; i < n && at + 8 <= data.length; i++) {
          const len = v.getUint32(at + 4, true);
          push(kindBase, id(i), {UNIONINDEX:v.getUint32(at, true), NAME:utf16(data.subarray(at + 8, at + 8 + len))}); at += 8 + len;
        }
        continue;
      }
      if (root === "primitiveguids") {  // 24-byte rows: [u32 object kind][u32 record index][16-byte GUID]
        const v = dv(data);
        for (let at = 0, i = 0; at + 24 <= data.length; at += 24, i++)
          push(kindBase, id(i), {OBJECTKIND:v.getUint32(at, true), INDEX:v.getUint32(at + 4, true), GUID:hex(data.subarray(at + 8, at + 24))});
        continue;
      }
      const rows = frames(data);
      if (isText(rows)) {
        rows.forEach((r, i) => {
          const p = props(r.bytes);
          let kind = kindBase;
          if (root === "classes6" || root === "signalclasses") kind += "/KIND=" + (p.KIND ?? "?");
          if (root === "primitiveparameters") kind += p.PRIMITIVEID != null ? "/PRIMITIVEID" : "/NAME";
          push(kind, id(i), p, {index:i});
        });
        continue;
      }
      if (root === "connections6" && rows) {
        rows.forEach((r, i) => { const g = r.bytes, v = dv(g);
          push(kindBase, id(i), {...header(g), X1:v.getInt32(13, true) * TICK, Y1:v.getInt32(17, true) * TICK, X2:v.getInt32(21, true) * TICK, Y2:v.getInt32(25, true) * TICK}); });
        continue;
      }
      // No known layout: one counted record (EmbeddedFonts6, LayerKindMapping, ConstraintManager, PadViaCacheLibraryLinksSection ...).
      const n = data.length > 8 ? dv(data).getUint32(0, true) : 0, label = n > 0 && n <= 256 ? utf16(data.subarray(4, 4 + n)) : "";
      push(kindBase, id(0), /^[\x20-\x7e]{2,}$/.test(label) ? {NAME:label} : {}, {bytes:data.length, counted:true});
    }
  }
  return entries;
}

// ------------------------------------------------------------------ model index
const near = (a, b, t = 1e-4) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= t;
const mod360 = a => ((a % 360) + 360) % 360;
const sameAngle = (a, b, t = 1e-3) => { const d = Math.abs(mod360(a) - mod360(b)); return d < t || 360 - d < t; };
const truthy = v => v === true || /^(true|t|1)$/i.test(String(v ?? ""));
const falsy = v => v === false || v == null || v === "" || /^(false|f|0)$/i.test(String(v));
// "12mil", "0.5mm", plain numbers (mil) -> mm
function dim(s) {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(mil|mm)?\s*$/i.exec(String(s ?? ""));
  return m ? (/mm/i.test(m[2] || "") ? +m[1] : +m[1] * 0.0254) : NaN;
}
const chars = s => (/^\d{1,5}(,\d{1,5})*$/.test(String(s)) ? String.fromCharCode(...String(s).split(",").map(Number)) : String(s ?? ""));

// Oracle layer names and Altium's text layer names -> Waffle layer keys.
function waffleLayer(name) {
  const n = String(name || "").toLowerCase().replace(/[ _-]/g, "");
  const fixed = {top:"Top", toplayer:"Top", bottom:"Bottom", bottomlayer:"Bottom", topoverlay:"Silk", bottomoverlay:"Bottom silk",
    toppaste:"Top paste", bottompaste:"Bottom paste", topsolder:"Top mask", bottomsolder:"Bottom mask", drillguide:"Drill guide",
    keepout:"Keepout", keepoutlayer:"Keepout", drilldrawing:"Drill drawing", multi:"Multi", multilayer:"Multi"};
  if (fixed[n]) return fixed[n];
  let m = /^mid(?:layer)?(\d+)$/.exec(n); if (m) return "Inner " + m[1];
  m = /^mech(?:anical)?(\d+)$/.exec(n); if (m) return "Mechanical " + m[1];
  return name;
}

function modelIndex(imported, files) {
  const model = imported.model, report = imported.report || {};
  const doc = model.documents.find(d => d.kind === "pcb") || model.documents[0];
  const defs = new Map((model.library || []).map(d => [d.id, d]));
  const items = doc.items || [], byId = new Map(items.map(i => [i.id, i]));
  const status = new Map();  // lower-case source object -> {kind, status, reason}
  for (const k of report.kinds || []) for (const r of references(k)) status.set(String(r.object || "").toLowerCase(), {kind:k.kind, status:r.status, reason:r.reason || ""});
  const srcToId = new Map();
  for (const m of report.modelObjects || []) for (const r of references(m)) if (r.id != null) srcToId.set(String(r.object || "").toLowerCase(), r.id);
  const notes = [...new Set([...(report.notes || []), ...(model.importNotes || []), ...(doc.notes || [])])];
  const omitted = new Set();
  for (const n of notes) { const m = /Omitted ([a-z0-9 ]+?) \(\d+\)\./i.exec(n); if (m) omitted.add(m[1].toLowerCase()); }
  // Footprint children are stored in the part's frame: global = rotate(local, angle) + (x, y).
  const place = (p, part) => { const r = (part.angle || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return [part.x + p[0] * c - p[1] * s, part.y + p[0] * s + p[1] * c]; };
  const prims = [];
  for (const it of items) {
    if (it.kind !== "part") { prims.push({obj:it, part:null, kind:it.kind, layer:it.layer, net:it.net || "", pts:it.points, x:it.x, y:it.y, angle:it.angle || 0, arc:it.arc && typeof it.arc === "object" ? it.arc : null}); continue; }
    const fp = defs.get(it.def)?.footprint;
    if (!fp) continue;
    for (const p of fp.pads || []) { const [x, y] = place([p.x, p.y], it); prims.push({obj:p, part:it, kind:p.kind || "pad", layer:p.layer, net:p.net || "", x, y, angle:(p.angle || 0) + (it.angle || 0)}); }
    for (const sh of fp.shapes || []) {
      const arc = sh.arc && typeof sh.arc === "object" ? {...sh.arc, c:place(sh.arc.c, it)} : null;
      prims.push({obj:sh, part:it, kind:sh.kind, layer:sh.layer, net:sh.net || "", pts:sh.points?.map(p => place(p, it)), arc,
        x:sh.x != null ? place([sh.x, sh.y], it)[0] : undefined, y:sh.y != null ? place([sh.x, sh.y], it)[1] : undefined, angle:(sh.angle || 0) + (it.angle || 0)});
    }
  }
  const netNames = new Set();
  const addNet = n => { if (n) netNames.add(n); };
  for (const p of prims) addNet(p.net);
  for (const it of items) { addNet(it.net); for (const n of Object.values(it.pinNets || {})) addNet(n); }
  for (const n of Object.keys(model.signals?.nets || {})) addNet(n);
  for (const p of doc.pcbDrawing?.pours || []) addNet(p.net);
  // Every text value the model holds (labels, footprint text, part labels, parameters).
  const texts = new Set();
  for (const p of prims) if (typeof p.obj.text === "string") texts.add(p.obj.text);
  for (const it of items) if (it.kind === "part") { texts.add(it.ref); texts.add(it.value); for (const l of [...(it.boardLabels || []), ...(it.hiddenBoardLabels || [])]) if (l.sourceTextBox?.text) texts.add(l.sourceTextBox.text); }
  return {model, report, doc, defs, items, byId, status, srcToId, notes, omitted, prims, netNames, texts, place, claimed:new Set(), files};
}

// The report's word on one source record: its own reference, else its stream's (Compound stream rows,
// "Omitted <stream> (n)." notes).
function reportOf(M, e) {
  const key = e.id.toLowerCase(), stream = key.replace(/#\d+$/, ""), root = stream.split("/")[0];
  const own = M.status.get(key);
  if (own) return own;
  const whole = M.status.get(stream);
  if (whole) return whole;
  if (M.omitted.has(root) || M.omitted.has(root.replace(/6$/, ""))) return {kind:"note", status:"dropped", reason:"Omitted " + root};
  return null;
}
const told = r => r && ["dropped", "approximated", "notApplicable"].includes(r.status);

// ------------------------------------------------------------------ locating objects
function claim(M, list, test) {
  for (const p of list) if (!M.claimed.has(p.obj) && test(p)) { M.claimed.add(p.obj); return p; }
  return null;
}
const pt = (x, y) => [x, -y];
const samePt = (a, b, t = 2e-4) => a && b && near(a[0], b[0], t) && near(a[1], b[1], t);

// Two records can share their geometry (a pad on each side at one position, a track drawn twice).
// account() locates every record of a kind strictly first (same owner, same layer), then the rest
// by geometry alone, so a record never takes its twin's object and a wrong layer or owner still shows.
const own = (M, e, layered = true) => { const part = M.ownerOf(e), layer = waffleLayer(e.fields.LAYER); return p => (p.part || null) === part && (!layered || p.layer === layer); };
const LOCATE = {
  Tracks6(M, e, strict) {
    const f = e.fields, a = pt(f.X1, f.Y1), b = pt(f.X2, f.Y2), fit = strict ? own(M, e) : () => true;
    const two = p => p.pts?.length === 2 && !p.arc && fit(p) && (samePt(p.pts[0], a) && samePt(p.pts[1], b) || samePt(p.pts[0], b) && samePt(p.pts[1], a));
    return claim(M, M.prims, p => two(p) && near(p.obj.width, f.WIDTH, 1e-4)) || claim(M, M.prims, two);
  },
  Arcs6(M, e, strict) {
    const f = e.fields, c = pt(f.X, f.Y), fit = strict ? own(M, e) : () => true;
    return claim(M, M.prims, p => p.arc && fit(p) && samePt(p.arc.c, c) && near(p.arc.r, Math.abs(f.RADIUS), 2e-4));
  },
  Vias6(M, e, strict) { const f = e.fields, fit = strict ? own(M, e, false) : () => true; return claim(M, M.prims, p => p.kind === "via" && fit(p) && samePt([p.x, p.y], pt(f.X, f.Y))); },
  Pads6(M, e, strict) { const f = e.fields, fit = strict ? own(M, e) : () => true;
    return claim(M, M.prims, p => p.kind === "pad" && fit(p) && samePt([p.x, p.y], pt(f.X, f.Y)) && String(p.obj.number ?? "") === f.NAME); },
  Fills6(M, e, strict) {
    // A fill is the rectangle X1,Y1..X2,Y2 turned by ROTATION about its centre.
    const f = e.fields, cx = (f.X1 + f.X2) / 2, cy = (f.Y1 + f.Y2) / 2, r = f.ROTATION * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), fit = strict ? own(M, e) : () => true;
    const corners = [[f.X1, f.Y1], [f.X2, f.Y1], [f.X2, f.Y2], [f.X1, f.Y2]].map(([x, y]) => pt(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c));
    return claim(M, M.prims, p => p.obj.fill && p.pts && fit(p) && corners.every(q => p.pts.some(w => samePt(w, q, 1e-3))));
  },
  Texts6(M, e) {
    const f = e.fields, o = pt(f.X, f.Y), layer = waffleLayer(f.LAYER);
    const origin = (at, angle, box) => { if (!box?.writingOffset) return [at]; const w = box.writingOffset, r = angle * Math.PI / 180;
      const turned = x => [at[0] + x * Math.cos(r) - w[1] * Math.sin(r), at[1] + x * Math.sin(r) + w[1] * Math.cos(r)];
      return [[at[0] + w[0], at[1] + w[1]], [at[0] - w[0], at[1] + w[1]], turned(w[0]), turned(-w[0]), at]; };
    if ((f.DESIGNATOR || f.COMMENT) && e.extra.comp != null) {
      const part = M.ownerOf(e);
      if (part) for (const l of [...(part.boardLabels || []), ...(part.hiddenBoardLabels || [])]) {
        if (l.field !== (f.DESIGNATOR ? "ref" : "value") || M.claimed.has(l)) continue;
        M.claimed.add(l);
        const at = M.place(l.at, part), angle = (l.angle || 0) + (part.angle || 0);
        return {obj:l, part, label:true, layer:l.layer, text:l.sourceTextBox?.text ?? (f.DESIGNATOR ? part.ref : part.value), origins:origin(at, angle, l.sourceTextBox), angle, size:l.size,
          hidden:(part.hiddenBoardLabels || []).includes(l)};
      }
      return null;
    }
    const hit = claim(M, M.prims, p => (p.kind === "label" || p.kind === "text") && p.obj.text === f.TEXT && p.layer === layer &&
      origin([p.x, p.y], p.angle, p.obj.sourceTextBox).some(q => samePt(q, o, 2e-3)));
    return hit && {...hit, text:hit.obj.text, origins:origin([hit.x, hit.y], hit.angle, hit.obj.sourceTextBox), size:hit.obj.size};
  },
  Regions6: region, ShapeBasedRegions6: region,
  ComponentBodies6: body, ShapeBasedComponentBodies6: body,
};
function boxOf(pts) { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, y] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); } return b; }
function region(M, e) {
  const b = e.extra.box; if (!b) return null;
  const box = [b[0], -b[3], b[2], -b[1]], same = (q, t = 2e-3) => q && q.every((v, i) => near(v, box[i], t));
  const shared = e.kind === "ShapeBasedRegions6";  // the authored twin of a Regions6 record: same object
  const layer = e.fields.V7_LAYER ? M.layerKey(e.fields.V7_LAYER) : waffleLayer(e.fields.LAYER), fit = p => same(p.b) && p.layer === layer;
  const pick = list => (shared ? list.find(fit) : claim(M, list, fit));
  M.regionPool ||= {
    shapes:M.prims.filter(p => p.pts && p.obj.closed && (p.obj.fill || p.obj.cutout || p.obj.keepout)).map(p => ({...p, b:boxOf(p.pts)})),
    pours:(M.doc.pcbDrawing?.pours || []).map(p => ({obj:p, kind:"pour", layer:p.layer, net:p.net || "", b:p.bounds})),
  };
  return pick(M.regionPool.shapes) || pick(M.regionPool.pours);
}
function body(M, e) {
  // Record n of ShapeBasedComponentBodies6 is the authored twin of record n of ComponentBodies6.
  M.bodyAt ||= new Map();
  if (e.kind !== "ComponentBodies6" && M.bodyAt.has(e.extra.index)) return M.bodyAt.get(e.extra.index);
  const found = bodyOf(M, e);
  if (e.kind === "ComponentBodies6" && found) M.bodyAt.set(e.extra.index, found);
  return found;
}
function bodyOf(M, e) {
  const part = M.ownerOf(e);
  const b = part && (part.bodies3d || []).find(x => x.modelId === e.fields.MODELID && (e.kind !== "ComponentBodies6" || !M.claimed.has(x)));
  if (!b) return null;
  if (e.kind === "ComponentBodies6") M.claimed.add(b);
  return {obj:b, part, layer:b.layer};
}

// ------------------------------------------------------------------ outside reasons
const WHY = {
  base:"Altium writes its placed-object base fields (selection, layer, lock, keep-out, union, user-routed) on every record. On a net, class, pair, rule or board record they hold the base default and describe nothing.",
  selection:"Selection state of the editor session.",
  identity:"Altium's object identity (UNIQUEID, GUID); Waffle mints its own ids. It names no design property.",
  view:"Editor view, grid, snap or display setting.",
  memory:"The editor's memory of the last value used (last route width, last via, last target length).",
  cache:"A cache Altium rebuilds (layer usage flags, the V9 layer cache, the hole-shape hash for drill symbols).",
  file:"File framing and version data: record counts, the file's name, save date and time, format version, version messages.",
  unused:"A slot of Altium's fixed layer table that is not in this board's stack: no object can sit on it.",
  outlinePolygon:"The board outline is stored as a polygon object; its pour settings never pour anything.",
  ratsnest:"Ratsnest lines Altium caches from net connectivity; Waffle recomputes them from the pads' nets.",
  legacyText:"Warning strings for pre-6.0 readers ('This is a version 6.0 file ...'), not board content.",
  colour:"Display colour of a net or xSignal (a view setting).",
  computed:"A total Altium computes from the routed copper (length, delay, current, resistance); it is a result, not an input.",
  tool:"Options of one of Altium's tools (pin swapper, cluster placer, Situs autorouter). They configure a tool run and describe nothing on the board.",
  solver:"Cached results of Altium's impedance solver; it recomputes them from the stack and the impedance profiles, which are counted in Board6.",
  noTexture:"Placement of a texture image on a body that has none (TEXTURE is blank).",
  generated:"An extruded, cylindrical or spherical body has no model file: Altium generates its shape from the outline and heights, which are compared. Its MODEL.CHECKSUM identifies that generated shape.",
  twinMarker:"Marks a record that carries UNICODE__ copies of its text fields; each copy is accounted with the field it copies.",
};
const BASE = {SELECTION:"FALSE", SELECTED:"FALSE", LOCKED:"FALSE", POLYGONOUTLINE:"FALSE", USERROUTED:"TRUE", KEEPOUT:"FALSE", UNIONINDEX:"0"};
const baseDefault = (f, v) => BASE[f] != null && String(v).toUpperCase() === BASE[f];

// ------------------------------------------------------------------ field rules
// A rule: {held(v, e, o, M, field, rawField) -> true | "why not" | {outside:why} | {reported:true} | {unmapped:why}} or {outside:why, when?(v, e, rawField, M)}.
// A field without a rule, or whose comparison fails and the report does not cover, is lost.
const H = fn => ({held:fn});
const OUT = (why, when) => ({outside:why, ...(when ? {when} : {})});
const sameNum = (a, b, t = 1e-4) => near(Number(a), Number(b), t);
const noGroup = H((v, e, o) => (Number(v) === 0 ? true : !!o?.obj?.groupId || "the union is not kept (no groupId)"));
// A free object and a component hold their own lock. A primitive inside a component (and a part's
// designator or comment string) has none in Waffle: an unlocked one has nothing to keep, and a locked
// one is accounted for only by the import note that counts them.
const CHILD_LOCK_NOTE = /Locks on primitives inside components not kept/;
const lockRule = H((v, e, o, M) => {
  const want = truthy(v);
  if (o?.part && o.obj !== o.part) return !want || (M.notes.some(n => CHILD_LOCK_NOTE.test(n)) ? {reported:true} : "locked in the source; a primitive inside a component has no lock in Waffle, and no import note says so");
  return want === (o?.obj?.locked === true) || (want ? "locked in the source, unlocked in Waffle" : "unlocked in the source, locked in Waffle");
});
const layerRule = H((v, e, o) => !o || waffleLayer(v) === o.layer || ("layer " + waffleLayer(v) + " ≠ " + o.layer));
// A layer named in record text (MID2, PLANE1) is a slot of Altium's fixed table; M.layerKey places it in the stack.
const textLayerRule = H((v, e, o, M) => !o || M.layerKey(v) === o.layer || ("layer " + M.layerKey(v) + " ≠ " + o.layer));
const netRule = H((v, e, o) => !o || (v || "") === (o.net || o.obj?.net || "") || ("net " + v + " ≠ " + (o.net || o.obj?.net)));
const compRule = H((v, e, o, M) => {
  if (!o) return false;
  if (v == null) return !o.part || "no owner in the source, owned by " + o.part.ref;
  const want = M.ownerOf(e);
  return !want ? "its component is not in the model" : o.part === want || "owned by " + (o.part?.ref ?? "no part") + ", not by " + want.ref;
});
const PRIM = {
  LAYER:layerRule, NET:netRule, COMPONENT:compRule, LOCKED:lockRule, UNIONINDEX:noGroup,
  KEEPOUT:H((v, e, o) => !o || !!v === !!(o.obj?.keepout || o.layer === "Keepout") || "keep-out flag differs"),
  POLYGONOUTLINE:H(v => v === false || "polygon outline primitive"),
  POLYGON:H((v, e, o) => (v == null ? !o?.obj?.sourcePour && o?.kind !== "pour" || "pour-owned in Waffle" : o?.kind === "pour" || !!o?.obj?.sourcePour || "not tied to its pour")),
  TESTPOINTTOP:H((v, e, o) => !!v === /^(Top|Both)$/.test(o?.obj?.fabTestpoint || "") || "test point (top) differs"),
  TESTPOINTBOTTOM:H((v, e, o) => !!v === /^(Bottom|Both)$/.test(o?.obj?.fabTestpoint || "") || "test point (bottom) differs"),
};
const xy = (fx, fy) => H((v, e, o) => !o || (o.pts || o.origins || [[o.x, o.y]]).some(p => near(p[0], e.fields[fx], 2e-3) && near(p[1], -e.fields[fy], 2e-3)) || "position differs");

const PRIMITIVE_FIELDS = {
  Tracks6:{...PRIM, X1:xy("X1", "Y1"), Y1:xy("X1", "Y1"), X2:xy("X2", "Y2"), Y2:xy("X2", "Y2"), WIDTH:H((v, e, o) => sameNum(o.obj.width, v) || "width")},
  Arcs6:{...PRIM, X:H((v, e, o) => near(o.arc.c[0], v, 2e-4)), Y:H((v, e, o) => near(o.arc.c[1], -v, 2e-4)), RADIUS:H((v, e, o) => near(o.arc.r, Math.abs(v), 2e-4)),
    WIDTH:H((v, e, o) => sameNum(o.obj.width, v) || "width"),
    STARTANGLE:H((v, e, o) => sweepOK(e.fields, o.arc) || "sweep differs"), ENDANGLE:H((v, e, o) => sweepOK(e.fields, o.arc) || "sweep differs")},
  Vias6:{...PRIM, X:H(() => true), Y:H(() => true), DIAMETER:H((v, e, o) => sameNum(o.obj.diameter, v)), HOLESIZE:H((v, e, o) => sameNum(o.obj.drill, v)),
    STARTLAYER:H((v, e, o) => waffleLayer(v) === (o.obj.fromLayer || "Top")), ENDLAYER:H((v, e, o) => waffleLayer(v) === (o.obj.toLayer || "Bottom")),
    LAYER:H((v, e, o) => waffleLayer(v) === "Multi" && o.obj.layer === "Multi")},
  Pads6:{...PRIM, NAME:H(() => true), X:H(() => true), Y:H(() => true),
    TOPXSIZE:H((v, e, o) => padSize(o.obj, "w", v) || "size"), TOPYSIZE:H((v, e, o) => padSize(o.obj, "h", v) || "size"),
    HOLESIZE:H((v, e, o) => (slotted(e) ? slotHeld(e, o.obj) : sameNum(o.obj.drill || 0, v)) || "hole " + v + " ≠ drill " + o.obj.drill),
    HOLESHAPE:H((v, e, o) => (v === 1 ? o.obj.holeShape === "square" || "a square hole, round in Waffle" : v === 2 ? !slotted(e) || o.obj.slotLength > 0 || "a slot, round in Waffle" : !(o.obj.slotLength > 0) || "a round hole, slotted in Waffle")),
    SLOTSIZE:H((v, e, o) => (slotted(e) ? slotHeld(e, o.obj) || "slot " + e.fields.HOLESIZE + " × " + v + " ≠ " + o.obj.drill + " × " + o.obj.slotLength : {outside:"Only read for a slotted hole."})),
    // Waffle's slot runs along its length; a source slot shorter than its hole is the same slot turned a quarter.
    SLOTROTATION:H((v, e, o) => { if (!slotted(e)) return {outside:"Only read for a slotted hole."};
      const want = v + (e.fields.HOLESIZE > e.fields.SLOTSIZE ? 90 : 0), have = o.obj.slotAngle || 0, half = (a, b) => sameAngle(a, b) || sameAngle(a + 180, b);
      return half(want, have) || half(-want, have) || "slot turned " + want + ", " + have + " in Waffle"; }),
    TOPSHAPE:H((v, e, o) => (rounded(e) ? /^roundrect$/ : {1:/^(round|oval|circle)$/, 2:/^rect$/, 3:/^octagon/}[v])?.test(topOf(o.obj).shape) || "shape " + v + (rounded(e) ? " (rounded rectangle)" : "") + " ≠ " + topOf(o.obj).shape),
    TOPALTSHAPE:H(() => true),  // read with TOPSHAPE: it only changes a round base shape into a rounded rectangle
    TOPCORNERRADIUS:H((v, e, o) => (rounded(e) ? sameNum(topOf(o.obj).roundrectRadiusRatio, v / 200, 1e-6) || "corner radius " + v + "% ≠ ratio " + topOf(o.obj).roundrectRadiusRatio
      : {outside:"The corner radius of a pad that is not a rounded rectangle; nothing reads it."})),
    ROTATION:H((v, e, o) => sameAngle(-v, o.angle) || "rotation"), PLATED:H((v, e, o) => v === (o.obj.plated !== false) || "plating"),
    STACKMODE:H((v, e, o) => (v === 0 ? !o.obj.stackMode || o.obj.stackMode === "simple" : v === 1 ? o.obj.stackMode === "tmb" : false) || "stack mode " + v)},
  Fills6:{...PRIM, X1:H(() => true), Y1:H(() => true), X2:H(() => true), Y2:H(() => true), ROTATION:H(() => true)},  // located by its four turned corners
  Texts6:{...PRIM, LAYER:layerRule, X:xy("X", "Y"), Y:xy("X", "Y"),
    TEXT:H((v, e, o) => o.text === v || /^\.(designator|comment)$/i.test(v) || "text " + o.text),
    HEIGHT:H((v, e, o) => sameNum(o.size, v) || "height"), ROTATION:H((v, e, o) => sameAngle(-v, o.angle) || "rotation"),
    MIRROR:H((v, e, o) => v === !!o.obj.mirrored || "mirror"), COMMENT:H(() => true), DESIGNATOR:H(() => true),
    // A designator or comment label is kept per part (boardLabels); lockRule treats it as a primitive inside the component.
    LOCKED:lockRule, COMPONENT:H((v, e, o, M) => (o.label ? o.part === M.ownerOf(e) : compRule.held(v, e, o, M)))},
};
// A slot is HOLESIZE by SLOTSIZE, in either order; Waffle keeps the short side as drill and the long one as slotLength.
const slotted = e => e.fields.HOLESHAPE === 2 && e.fields.SLOTSIZE > 0 && !sameNum(e.fields.SLOTSIZE, e.fields.HOLESIZE);
const slotHeld = (e, p) => sameNum(p.drill, Math.min(e.fields.HOLESIZE, e.fields.SLOTSIZE)) && sameNum(p.slotLength, Math.max(e.fields.HOLESIZE, e.fields.SLOTSIZE));
const rounded = e => e.fields.TOPSHAPE === 1 && e.fields.TOPALTSHAPE === 9;
const topOf = p => (p.padStack?.Top?.shape ? p.padStack.Top : p);
// A top-middle-bottom pad keeps the top row in padStack.Top and its nominal size in w/h.
function padSize(p, k, v) { const top = p.padStack?.Top; return top ? sameNum(top[k], v) && (!(top.w > 0) || sameNum(p[k], top[k])) : sameNum(p[k], v); }
function sweepOK(f, arc) {
  const s = mod360(f.ENDANGLE - f.STARTANGLE) || 360, w = mod360(Math.abs(arc.end - arc.start)) || 360;
  return near(s, w, 1e-3) || near(360 - s, w, 1e-3);
}
// Region and 3D-body property text (on top of the binary header).
const REGION_FIELDS = {
  ...PRIM, NET:H((v, e, o) => !o || (v || "") === (o.net || "") || !v && o.kind === "pour" || "net " + v + " ≠ " + o.net), V7_LAYER:textLayerRule, NAME:H(v => !String(v).trim() || "named region"), KIND:H((v, e, o) => Number(v) === 0 && (!o || !o.obj.cutout && !o.obj.keepout) || Number(v) !== 0 && !!(o?.obj.cutout || o?.obj.keepout) || "region kind " + v),
  SUBPOLYINDEX:H((v, e, o) => (Number(v) < 0 ? true : o?.kind === "pour" || "an island of a pour, not tied to it")),
  ARCRESOLUTION:OUT("The tessellation tolerance Altium used for this record's stored contour; the contour itself is compared."),
  ISSHAPEBASED:H(v => falsy(v) || "shape-based flag"), CAVITYHEIGHT:H(v => near(dim(v), 0, 1e-9) || "cavity"),
  ISBOARDCUTOUT:H((v, e, o) => falsy(v) || !!o?.obj?.boardCutout), UNIONINDEX:noGroup,
};
const isFile = e => Number(e.fields["MODEL.MODELTYPE"]) === 1;  // 0 extruded, 1 model file, 2 cylinder, 3 sphere
const BODY_FIELDS = {
  ...PRIM, V7_LAYER:textLayerRule, NAME:H(v => !String(v).trim()), KIND:H(v => Number(v) === 0), SUBPOLYINDEX:H(v => Number(v) < 0), UNIONINDEX:noGroup,
  ARCRESOLUTION:OUT("The tessellation tolerance of the body's stored outline."), ISSHAPEBASED:H(v => falsy(v)), CAVITYHEIGHT:H(v => near(dim(v), 0, 1e-9)),
  LAYER:H((v, e, o) => waffleLayer(v) === o.obj.layer), NET:H(v => !v), POLYGON:H(v => v == null), KEEPOUT:H(v => !v), LOCKED:lockRule,
  COMPONENT:H(() => true),
  MODELID:H(() => true), "MODEL.NAME":H((v, e, o, M) => !isFile(e) && !v || (M.doc.bodyModels || []).some(m => m.id === o.obj.modelId && m.file === v) || "model file name"),
  "MODEL.CHECKSUM":H((v, e, o, M) => (!isFile(e) ? {outside:WHY.generated} : (M.doc.bodyModels || []).some(m => m.id === o.obj.modelId && m.checksum === (Number(v) >>> 0)) || "checksum")),
  "MODEL.EXTRUDED.MINZ":H((v, e, o) => (Number(e.fields["MODEL.MODELTYPE"]) !== 0 ? {outside:"Only read for an extruded body."} : near(dim(v), o.obj.minZ, 1e-3) || "extrusion bottom " + o.obj.minZ)),
  "MODEL.EXTRUDED.MAXZ":H((v, e, o) => (Number(e.fields["MODEL.MODELTYPE"]) !== 0 ? {outside:"Only read for an extruded body."} : near(dim(v), o.obj.maxZ, 1e-3) || "extrusion top " + o.obj.maxZ)),
  "MODEL.EMBED":H((v, e, o, M) => !truthy(v) || (M.doc.bodyModels || []).some(m => m.id === o.obj.modelId && m.zlib) || "embedded model"),
  IDENTIFIER:H((v, e, o) => chars(v) === o.obj.identifier || "identifier"),
  STANDOFFHEIGHT:H((v, e, o) => near(dim(v), o.obj.minZ, 1e-3) || "standoff " + o.obj.minZ),
  OVERALLHEIGHT:H((v, e, o) => near(dim(v), o.obj.maxZ, 1e-3) || "overall height " + o.obj.maxZ),
  "MODEL.3D.ROTX":H((v, e, o) => sameAngle(+v, o.obj.rotation?.[0] ?? 0)), "MODEL.3D.ROTY":H((v, e, o) => sameAngle(+v, o.obj.rotation?.[1] ?? 0)),
  "MODEL.3D.ROTZ":H((v, e, o) => sameAngle(+v, o.obj.rotation?.[2] ?? 0)), "MODEL.3D.DZ":H((v, e, o) => near(dim(v), o.obj.dz ?? 0, 1e-3)),
  BODYCOLOR3D:H((v, e, o) => Number(v) === o.obj.color), BODYOPACITY3D:H((v, e, o) => near(+v, o.obj.opacity ?? 1, 1e-3)),
  "MODEL.2D.X":H((v, e, o, M) => near(dim(v), M.place(o.obj.at || [0, 0], o.part)[0], 2e-3) || "model origin x"),
  "MODEL.2D.Y":H((v, e, o, M) => near(-dim(v), M.place(o.obj.at || [0, 0], o.part)[1], 2e-3) || "model origin y"),
  // No extra 2D model rotation: the body turns with its part.
  "MODEL.2D.ROTATION":H((v, e, o) => sameAngle(+v, 0) && sameAngle(o.obj.angle ?? o.part.angle ?? 0, o.part.angle ?? 0) || "model 2D rotation " + v),
  "MODEL.MODELTYPE":H((v, e, o) => (Number(v) === 1 ? o.obj.type === "step" : Number(v) === 0 ? o.obj.type === "extruded" : false) || "model type " + v + " as " + o.obj.type),
  "MODEL.MODELSOURCE":H(v => /^Undefined$/i.test(v) || "model source " + v),
  TEXTURE:H(v => !v || "textured body"), TEXTURECENTERX:OUT(WHY.noTexture, (v, e) => !e.fields.TEXTURE), TEXTURECENTERY:OUT(WHY.noTexture, (v, e) => !e.fields.TEXTURE),
  TEXTURESIZEX:OUT(WHY.noTexture, (v, e) => !e.fields.TEXTURE), TEXTURESIZEY:OUT(WHY.noTexture, (v, e) => !e.fields.TEXTURE),
  TEXTUREROTATION:OUT(WHY.noTexture, (v, e) => !e.fields.TEXTURE),
  BODYPROJECTION:H((v, e, o) => (Number(v) === 0 ? o.obj.side === o.part.layer || o.obj.ownerSide === o.part.layer || o.obj.side === "Top" : false) || "projection " + v),
};

// Text records. Common base fields on records that are not placed objects.
const COMMON = {
  SELECTION:OUT(WHY.selection), SELECTED:OUT(WHY.selection), UNIQUEID:OUT(WHY.identity),
  LAYER:OUT(WHY.base, (v, e) => /^(MULTILAYER|TOP|UNKNOWN)$/i.test(v)), LOCKED:OUT(WHY.base, v => baseDefault("LOCKED", v)),
  POLYGONOUTLINE:OUT(WHY.base, v => baseDefault("POLYGONOUTLINE", v)), USERROUTED:OUT(WHY.base, v => baseDefault("USERROUTED", v)),
  KEEPOUT:OUT(WHY.base, v => baseDefault("KEEPOUT", v)), UNIONINDEX:OUT(WHY.base, v => baseDefault("UNIONINDEX", v)),
  PRIMITIVELOCK:OUT(WHY.base, v => /^(TRUE|FALSE)$/i.test(v)),
};

function classMembers(e) { const out = []; for (let i = 0; e.fields["M" + i] != null; i++) out.push(e.fields["M" + i]); return out; }
const CLASS_FIELDS = {
  ...COMMON, KIND:H(() => true), NAME:H(() => true), SUPERCLASS:H(() => true),
  "M<n>":H((v, e, o) => (o?.members || []).includes(v) || "member " + v + " not in the Waffle class"),
  SCHAUTOGENERATEDCLUSTER:H(v => falsy(v) || "schematic cluster class"),
  AUTOGENERATEDCLASS:H((v, e, o) => true), AUTOGENERATEDCLASSKIND:H(() => true),
};

// Rules: Altium field -> Waffle rule property, per rule kind. Unlisted fields fall back to a value search.
const RULE_ALIASES = {
  Clearance:{GAP:"gap", GENERICCLEARANCE:"gap"}, BoardOutlineClearance:{GAP:"gap", GENERICCLEARANCE:"gap"},
  Width:{MAXLIMIT:"max", MINLIMIT:"min", PREFEREDWIDTH:"preferred"}, Height:{MINHEIGHT:"min", MAXHEIGHT:"max", PREFHEIGHT:"preferred"},
  HoleSize:{MAXLIMIT:"max", MINLIMIT:"min"}, MinimumAnnularRing:{MINIMUMRING:"min"},
  SolderMaskExpansion:{EXPANSION:"expansion", ISTENTINGTOP:"tentTop", ISTENTINGBOTTOM:"tentBottom"}, PasteMaskExpansion:{EXPANSION:"expansion"},
  HoleToHoleClearance:{GAP:"gap", ALLOWSTACKEDMICROVIAS:"allowStackedMicrovias"}, SilkToSilkClearance:{SILKTOSILKCLEARANCE:"gap"},
  SilkToSolderMaskClearance:{MINSILKSCREENTOMASKGAP:"gap", CLEARANCETOEXPOSEDCOPPER:"exposedCopper"},
  ComponentClearance:{GAP:"gap", VERTICALGAP:"vertical"},
  RoutingVias:{WIDTH:"diameterPreferred", MINWIDTH:"diameterMin", MAXWIDTH:"diameterMax", HOLEWIDTH:"holePreferred", MINHOLEWIDTH:"holeMin", MAXHOLEWIDTH:"holeMax"},
  RoutingCorners:{MINSETBACK:"setbackMin", MAXSETBACK:"setbackMax"}, RoutingPriority:{ROUTINGPRIORITY:"value"},
  PolygonConnect:{RELIEFCONDUCTORWIDTH:"conductorWidth", RELIEFENTRIES:"entries", AIRGAPWIDTH:"airGap"},
  DiffPairsRouting:{MINLIMIT:"gapMin", MAXLIMIT:"gapMax", MOSTFREQGAP:"gapPreferred", MAXUNCOUPLEDLENGTH:"maxUncoupled",
    TOPLAYER_MINWIDTH:"widthMin", TOPLAYER_MAXWIDTH:"widthMax", TOPLAYER_PREFWIDTH:"widthPreferred",
    BOTTOMLAYER_MINWIDTH:"widthMin", BOTTOMLAYER_MAXWIDTH:"widthMax", BOTTOMLAYER_PREFWIDTH:"widthPreferred"},
  FabricationTestpoint:{MINSIZE:"minSize", MAXSIZE:"maxSize", PREFEREDSIZE:"preferredSize", MINHOLESIZE:"minHole", MAXHOLESIZE:"maxHole",
    PREFEREDHOLESIZE:"preferredHole", ALLOWSIDETOP:"allowTop", ALLOWSIDEBOTTOM:"allowBottom"},
  LayerPairs:{ENFORCE:"enforce"}, ShortCircuit:{ALLOWED:"allowed"}, MatchedLengths:{TOLERANCE:"tolerance", CHECKNETSINDIFFPAIR:"withinPair"},
};
function ruleValue(field, v, rule, kind) {
  const alias = RULE_ALIASES[kind]?.[field];
  const d = dim(v), bool = /^(TRUE|FALSE)$/i.test(v) ? /^TRUE$/i.test(v) : null;
  const eq = x => (bool != null ? x === bool : Number.isFinite(d) && typeof x === "number" ? near(x, d, 1e-5) || near(x, Number(v), 1e-9)
    : typeof x === "string" && x.toLowerCase() === String(v).toLowerCase());
  if (alias) return eq(rule[alias]) || field + "=" + v + " but " + alias + "=" + JSON.stringify(rule[alias]);
  // No alias: an equal value under a property whose name shares a word with the field (strings and numbers
  // also by value alone when the value is distinctive: non-zero and not a bare boolean).
  const leaves = [];
  (function walk(o, k) { if (o && typeof o === "object") { for (const [kk, vv] of Object.entries(o)) if (!["id", "origin", "boards", "exceptBoards", "scope", "scope2"].includes(kk)) walk(vv, kk); } else leaves.push([k, o]); })(rule, "");
  const words = k => String(k).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4);
  const f = field.toLowerCase();
  const named = k => words(k).some(w => f.includes(w));
  const hit = leaves.some(([k, x]) => eq(x) && (named(k) || bool == null && (typeof x === "string" ? x.length > 1 : x !== 0)));
  return hit || {unmapped:"no property of the Waffle rule is known to hold " + field + ", and none has an equal value"};
}
function ruleScope(expr, scope) {
  if (!scope) return "no scope";
  const src = String(scope.source || "");
  if (/^\s*All\s*$/i.test(expr)) return /^object$/.test(src.trim()) || "All became " + src;
  const names = [...String(expr).matchAll(/'([^']*)'/g)].map(m => m[1]);
  if (names.length) return names.every(n => src.toLowerCase().includes(n.toLowerCase())) || "scope " + expr + " became " + src;
  return src.trim() !== "object" || "scope " + expr + " became " + src;
}
// A rule keeps a width per layer in layers[<layer>] where it differs from the rule's own.
const layerWidth = (key, short) => H((v, e, o, M, nf, f) => {
  if (!M.hasLayer(f)) return {outside:WHY.unused};
  const layer = M.layerKey(f.split("_")[0]), have = o.obj.layers?.[layer]?.[key] ?? o.obj[key] ?? o.obj[short];
  return near(have, dim(v), 1e-5) || f + "=" + v + " but " + layer + " " + key + "=" + have;
});
const RULE_FIELDS = {
  ...COMMON, RULEKIND:H(() => true), NAME:H((v, e, o) => o.obj.name === v || "name"), ENABLED:H((v, e, o) => truthy(v) === (o.obj.enabled !== false) || "enabled"),
  PRIORITY:H((v, e, o) => Number(v) === o.obj.priority || "priority " + o.obj.priority), COMMENT:H((v, e, o) => (o.obj.comment || "") === v || "comment"),
  "SCOPE<n>EXPRESSION":H((v, e, o, M, nf, f) => {
    // A Waffle rule with one scope holds a pair's only restriction in it, whichever side Altium wrote it on.
    const all = x => /^\s*All\s*$/i.test(x ?? "All"), first = f === "SCOPE1EXPRESSION", other = e.fields[first ? "SCOPE2EXPRESSION" : "SCOPE1EXPRESSION"];
    if (!o.obj.scope2 && all(v) !== all(other)) return ruleScope(all(v) ? other : v, o.obj.scope);
    return ruleScope(v, first ? o.obj.scope : o.obj.scope2 ?? (all(v) ? {source:"object"} : null));
  }),
  NETSCOPE:H(v => /^(AnyNet|DifferentNets)$/i.test(v) || "net scope " + v), LAYERKIND:H(v => /^SameLayer$/i.test(v) || "layer kind " + v),
  DEFINEDBYLOGICALDOCUMENT:H(v => falsy(v) || "defined by a schematic directive"),
  OBJECTCLEARANCES:H(v => !v || "per-object clearance matrix"),
  IGNOREPADTOPADCLEARANCEINFOOTPRINT:H(v => falsy(v) || "ignores pad-to-pad clearance in footprints"),
  SHOWDISTANCES:OUT(WHY.view),
  // DiffPairsRouting writes widths for all 32 copper slots; only the stack's layers carry meaning.
  "MIDLAYER<n>_MINWIDTH":layerWidth("widthMin", "min"), "MIDLAYER<n>_MAXWIDTH":layerWidth("widthMax", "max"), "MIDLAYER<n>_PREFWIDTH":layerWidth("widthPreferred", "preferred"),
  "MID LAYER <n>_V5":H((v, e, o, M, nf, f) => !M.hasLayer(f.replace(/ /g, "")) || truthy(v) !== (o.obj.excluded || []).includes(M.layerKey("MID" + /\d+/.exec(f)[0])) || "routing on " + f),
  "TOP LAYER_V5":H((v, e, o) => truthy(v) !== (o.obj.excluded || []).includes("Top") || "routing on Top"),
  "BOTTOM LAYER_V5":H((v, e, o) => truthy(v) !== (o.obj.excluded || []).includes("Bottom") || "routing on Bottom"),
  // HoleSize: percentages apply only when ABSOLUTEVALUES is FALSE.
  MAXPERCENT:H((v, e) => truthy(e.fields.ABSOLUTEVALUES) || "relative hole-size limits"), MINPERCENT:H((v, e) => truthy(e.fields.ABSOLUTEVALUES) || "relative hole-size limits"),
  ABSOLUTEVALUES:H(v => truthy(v) || "relative hole-size limits"),
  CORNERSTYLE:H((v, e, o) => String(o.obj.style) === String(v).replace(/-Degrees?$/i, "") || /^rounded$/i.test(v) && /round/.test(o.obj.style) || "corner style " + v + " ≠ " + o.obj.style),
  CONNECTSTYLE:H((v, e, o) => String(o.obj.style).toLowerCase() === String(v).toLowerCase() || "connect style"),
  POLYGONRELIEFANGLE:H((v, e, o) => Number(String(v).replace(/\D+/g, "")) === o.obj.angle || "relief angle"),
  VIASTYLE:H(v => /^Through Hole$/i.test(v) || "via style " + v),
  TOPOLOGY:H((v, e, o) => String(o.obj.topology).toLowerCase() === String(v).toLowerCase() || "topology"),
};

// Board6: grouped by field family (indexed keys as <n>).
function boardFieldRule(name) {
  for (const [re, rule] of BOARD_RULES) if (re.test(name)) return rule;
  return null;
}
const stackLayers = M => (M.doc.stackup?.layers || []);
const copperOf = M => stackLayers(M).filter(l => l.type === "Signal" || l.type === "Plane");
const dielOf = M => stackLayers(M).filter(l => l.type === "Dielectric");
const inChain = (M, f) => { const m = /^LAYER(\d+)/.exec(f); return m && M.chain.includes(Number(m[1])); };
const chainPos = (M, f) => M.chain.indexOf(Number(/^LAYER(\d+)/.exec(f)[1]));
// A value the stack holds somewhere (the newer V8/V9 copies of the stack table).
const inStack = (M, v) => {
  const d = dim(v), n = Number(v);
  return stackLayers(M).some(l => l.name === v || l.material === v || Number.isFinite(d) && /mil|mm/i.test(v) && near(l.thickness, d, 1e-4) || Number.isFinite(n) && !/mil|mm/i.test(v) && near(l.dk, n, 1e-6))
    || FIXED_LAYER_NAMES.has(v) || Object.values(M.doc.layerNames || {}).includes(v) || /^Mechanical \d+$/.test(v)
    || /^Dielectric( \d+)?$/.test(v) && dielOf(M).length > 0;
};
const FIXED_LAYER_NAMES = new Set(["Top Layer", "Bottom Layer", "Top Overlay", "Bottom Overlay", "Top Paste", "Bottom Paste", "Top Solder", "Bottom Solder",
  "Multi-Layer", "Keep-Out Layer", "Drill Guide", "Drill Drawing"]);
const mechUsed = (M, k) => M.usedLayers.has("Mechanical " + k);
const BOARD_RULES = [
  [/^(SELECTION)$/, OUT(WHY.selection)], [/^UNIQUEID$/, OUT(WHY.identity)],
  [/^(LAYER|LOCKED|POLYGONOUTLINE|USERROUTED|KEEPOUT|UNIONINDEX|PRIMITIVELOCK)$/, OUT(WHY.base)],
  [/^(FILENAME|KIND|VERSION|DATE|TIME|RECORD)$/, OUT(WHY.file)],
  [/^(POLYGONTYPE|POUROVER|REMOVEDEAD|GRIDSIZE|TRACKWIDTH|HATCHSTYLE|USEOCTAGONS|MINPRIMLENGTH|SHELVED|RESTORELAYER|RESTORENET|REMOVEISLANDSBYAREA|REMOVENECKS|AREATHRESHOLD|ARCRESOLUTION|NECKWIDTHTHRESHOLD|POUROVERSTYLE|NAME|POURINDEX|IGNOREVIOLATIONS|OPTIMALVOIDROTATION)$/, OUT(WHY.outlinePolygon)],
  // Outline: VX/VY vertices, KIND 1 arcs about CX/CY from SA to EA.
  [/^V[XY]<n>$/, H((v, e, o, M, nf, f) => { const i = +/\d+/.exec(f)[0], x = dim(e.fields["VX" + i]), y = -dim(e.fields["VY" + i]);
    return (M.doc.outline || []).some(p => near(p[0], x, 1e-4) && near(p[1], y, 1e-4)) || "outline vertex " + i + " missing"; })],
  [/^KIND<n>$/, H((v, e, o, M) => Number(v) === 0 || !!M.doc.boardShape || "outline arc")],
  [/^(CX|CY|SA|EA|R)<n>$/, H((v, e, o, M, nf, f) => (Number(e.fields["KIND" + /\d+/.exec(f)[0]]) === 0 ? true : !!M.doc.boardShape) || "outline arc")],
  [/^ORIGIN[XY]$/, H((v, e, o, M, f) => near((M.doc.origin || [0, 0])[f === "ORIGINX" ? 0 : 1], f === "ORIGINX" ? dim(v) : -dim(v), 1e-4) || "origin")],
  [/^SPLITLINECOUNT$/, H(v => Number(v) === 0 || "split plane lines")],
  [/^(BIGVISIBLEGRIDSIZE|VISIBLEGRIDSIZE|ELECTRICALGRID.*|SNAPGRID.*|TRACKGRIDSIZE|VIAGRIDSIZE|COMPONENTGRID.*|DOTGRID|DISPLAYUNIT|DESIGNATORDISPLAYMODE|SHEET.*|SHOWSHEET|LOCKSHEET|TOGGLELAYERS|PLACEMARKER[XY]<n>|SELECTIONMEMORYLOCK<n>|SHOWDEFAULTSETS|LAYERSETSCOUNT|LAYERSET<n>.*|BOARDINSIGHTVIEWCONFIGURATIONNAME|VISIBLEGRIDMULTFACTOR|BIGVISIBLEGRIDMULTFACTOR|CURRENT2D3DVIEWSTATE|VP\..*|[23]DCONFIG.*|LOOKAT\..*|EYEROTATION\..*|ZOOMMULT|VIEWSIZE\..*|GR<n>_.*|EG.*|OGSNAPENABLED|MGSNAPENABLED|POINTGUIDEENABLED|GRIDSNAPENABLED|NEAROBJECTS.*|FAROBJECTS.*|NEARDISTANCE|VIEWPORTSAREVISIBLE|SHOWSIGNALLAYERSONLY|LAYERSTACKSTYLE|SHOWTOPDIELECTRIC|SHOWBOTTOMDIELECTRIC)$/, OUT(WHY.view)],
  [/^(TOPLAYER|BOTTOMLAYER|MIDLAYER<n>)_MRLASTWIDTH$|^(MRLASTVIASIZE|MRLASTVIAHOLE|LASTTARGETLENGTH)$/, OUT(WHY.memory)],
  [/^(HOLESHAPEHASHSIZE|HASHKEY#?<n>|HASHVALUE#?<n>)$/, OUT(WHY.cache)],
  [/^SITUSSTRATEGY/, OUT(WHY.tool)], [/^SELECTIONFILTER_/, OUT(WHY.selection)], [/^SNAPPINGENTITYSET$/, OUT(WHY.view)], [/^ROUTELASTVIA\./, OUT(WHY.memory)],
  [/^LAYERCOUNT$/, H(v => Number(v) === 0 || "layer list")],
  [/^(OUTLINEMODELCRC|OUTLINEMODELNAME)$/, H(v => !v || v === "0" || "board outline 3D model")],
  [/^ROUTINGDIRECTION.*$/, H(v => /^Automatic$/i.test(v) || "preferred routing direction " + v)],
  // Legacy layer table LAYER<id>...: ids in the stack chain against doc.stackup, the rest are unused slots.
  [/^LAYER<n>NAME$/, H((v, e, o, M, f, raw) => {
    const id = +/\d+/.exec(raw)[0];
    if (M.chain.includes(id)) return copperOf(M)[M.chain.indexOf(id)]?.name === v || "stack layer name";
    if (id >= 57 && id <= 72) return (M.doc.layerNames?.["Mechanical " + (id - 56)] ?? "Mechanical " + (id - 56)) === v || (!truthy(e.fields["LAYER" + id + "MECHENABLED"]) ? {outside:WHY.unused} : "mechanical layer name " + JSON.stringify(v) + " not kept");
    if ([33, 34, 35, 36, 37, 38, 55, 56, 73, 74].includes(id)) return FIXED_LAYER_NAMES.has(v) || "renamed fixed layer";
    return {outside:WHY.unused};
  })],
  [/^LAYER<n>(PREV|NEXT)$/, H((v, e, o, M, f, raw) => !inChain(M, raw) ? {outside:WHY.unused} : copperOf(M).length === M.chain.length || "stack order")],
  [/^LAYER<n>COPTHICK$/, H((v, e, o, M, f, raw) => !inChain(M, raw) ? {outside:WHY.unused} : near(copperOf(M)[chainPos(M, raw)]?.thickness, dim(v), 1e-4) || "copper thickness")],
  [/^LAYER<n>DIEL(TYPE|CONST|HEIGHT|MATERIAL)$/, H((v, e, o, M, f, raw) => {
    if (!inChain(M, raw) || chainPos(M, raw) === M.chain.length - 1) return {outside:"A slot of the fixed layer table outside the stack, or the dielectric field of the bottom layer (nothing lies below it)."};
    const d = dielOf(M)[chainPos(M, raw)];
    if (!d) return "dielectric missing";
    if (/HEIGHT/.test(f)) return near(d.thickness, dim(v), 1e-4) || "dielectric height";
    if (/CONST/.test(f)) return near(d.dk, +v, 1e-6) || "dielectric constant";
    if (/MATERIAL/.test(f)) return d.material === v || "dielectric material";
    return (Number(v) === 2) === (d.dielectric === "Prepreg") || "dielectric type";
  })],
  [/^LAYER<n>MECHENABLED$/, H((v, e, o, M, f, raw) => { const id = +/\d+/.exec(raw)[0]; return !(id >= 57 && id <= 72) ? {outside:WHY.unused} : !truthy(v) || mechUsed(M, id - 56) || "enabled mechanical layer " + (id - 56) + " not kept"; })],
  [/^LAYER<n>MECHKIND$/, H(() => "Waffle keeps no mechanical layer kind")],
  [/^(TOP|BOTTOM)(TYPE|CONST|HEIGHT|MATERIAL)$/, H((v, e, o, M, f) => {
    const s = stackLayers(M).find(l => l.name === (f.startsWith("TOP") ? "Top" : "Bottom") + " Solder");
    if (!s) return "solder mask layer missing";
    if (/HEIGHT/.test(f)) return near(s.thickness, dim(v), 1e-4) || "mask thickness"; if (/CONST/.test(f)) return near(s.dk, +v, 1e-6) || "mask dk";
    if (/MATERIAL/.test(f)) return s.material === v || "mask material"; return Number(v) === 3 || "mask type " + v;
  })],
  // Drill layer pairs: Top-Bottom is the through pair Waffle assumes when stackup.drillPairs is empty.
  [/^LAYERPAIR<n>(LOW|HIGH)$/, H((v, e, o, M, nf, f) => { const i = /\d+/.exec(f)[0], lo = M.layerKey(e.fields["LAYERPAIR" + i + "LOW"]), hi = M.layerKey(e.fields["LAYERPAIR" + i + "HIGH"]), pairs = M.doc.stackup?.drillPairs || [];
    return lo === "Top" && hi === "Bottom" && !pairs.length || pairs.some(p => JSON.stringify(p).includes(lo) && JSON.stringify(p).includes(hi)) || "drill pair " + lo + "-" + hi; })],
  [/^LAYERPAIR<n>(DRILLGUIDE|DRILLDRAWING)$/, H(v => falsy(v) || "drill guide or drill drawing output for the pair")],
  [/^LAYERPAIR<n>SUBSTACK_<n>$/, OUT(WHY.identity)],
  [/^PLANE<n>NETNAME$/, H((v, e, o, M, f) => v === "(No Net)" || M.items.some(i => i.powerPlane && i.net === v) || "plane net")],
  [/^V9_CACHE_.*$/, OUT(WHY.cache)],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>|LAYERV7_<n>_?)(ID|LAYERID)$/, OUT(WHY.identity)],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>|LAYERV7_<n>_?)(USEDBYPRIMS)$|USEDBYPRIMS$/, OUT(WHY.cache)],
  [/^(V9_MASTERSTACK|LAYERMASTERSTACK_V8|V9_SUBSTACK<n>|LAYERSUBSTACK_V8_<n>)_?(ID)$/, OUT(WHY.identity)],
  [/^(V9_MASTERSTACK|LAYERMASTERSTACK_V8|V9_SUBSTACK<n>|LAYERSUBSTACK_V8_<n>)_?(SHOWTOPDIELECTRIC|SHOWBOTTOMDIELECTRIC|STYLE)$/, OUT(WHY.view)],
  [/^(V9_MASTERSTACK|LAYERMASTERSTACK_V8|V9_SUBSTACK<n>|LAYERSUBSTACK_V8_<n>)_?ISFLEX$/, H(v => falsy(v) || "flex stack")],
  [/^LAYERV7_<n>_?(NAME|PREV|NEXT|MECHENABLED|COPTHICK|DIEL.*)$/, OUT(WHY.unused, (v, e, raw) => !truthy(e.fields[raw.replace(/(NAME|PREV|NEXT|COPTHICK|DIEL\w+)$/, "MECHENABLED")]))],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>)NAME$/, H((v, e, o, M, nf, f) => {
    // V8/V9 layer ids: 0x1020001.. are Mechanical 1..32; 0x1030010..0x103001A are display layers (connections, grids, markers, selections).
    const lid = Number(e.fields[f.replace(/NAME$/, "LAYERID")]), en = e.fields[f.replace(/NAME$/, "MECHENABLED")];
    if (lid >= 16908289 && lid <= 16908320) { const k = lid - 16908288;
      return (M.doc.layerNames?.["Mechanical " + k] ?? "Mechanical " + k) === v || (!truthy(en) ? {outside:WHY.unused} : "mechanical layer name " + JSON.stringify(v) + " not kept"); }
    if (lid >= 16973840 && lid <= 16973850) return {outside:WHY.view};
    return inStack(M, v) || JSON.stringify(v) + " is not in the Waffle stack";
  })],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>)(COPTHICK|DIELCONST|DIELHEIGHT|DIELMATERIAL)$/, H((v, e, o, M) => inStack(M, v) || JSON.stringify(v) + " is not in the Waffle stack")],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>)DIELTYPE$/, H(v => [0, 1, 2, 3].includes(Number(v)) || "dielectric type")],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>)COMPONENTPLACEMENT$/, H(v => [0, 1, 2].includes(Number(v)) || "component side")],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>)COVERLAY_EXPANSION$/, H(v => near(dim(v), 0, 1e-9) || "coverlay")],
  [/^(V9_STACK_LAYER<n>_|LAYER_V8_<n>)MECHENABLED$/, H((v, e, o, M, f, raw) => true)],
  // Pin pairs (xSignals) against the signal model's paths.
  [/^PINPAIRCOUNT$/, H((v, e, o, M) => Number(v) === M.xsignals.length || "xSignal count " + M.xsignals.length)],
  [/^PINPAIRNAME<n>$/, H((v, e, o, M) => M.xsignals.some(p => p.name === v) || "xSignal " + v + " missing")],
  [/^PINPAIRPINS<n>$/, H((v, e, o, M, f, raw) => {
    const name = e.fields["PINPAIRNAME" + /\d+/.exec(raw)[0]], p = M.xsignals.find(x => x.name === name);
    if (!p) return "xSignal missing";
    const pins = v.split(","), ref = id => M.byId.get(id)?.ref, end = (s, q) => s === ref(q?.part) + "-" + q?.pin;
    const through = [...new Set(pins.slice(1, -1).map(s => s.split("-")[0]))];
    return end(pins[0], p.from) && end(pins.at(-1), p.to) && through.every(t => (p.through || []).includes(t)) || "path " + v;
  })],
  [/^PINPAIR(PINUNIQUEIDS|GUID)<n>$/, OUT(WHY.identity)],
  [/^PINPAIR(COLOR|OVERRIDECOLORFORDRAW)<n>$/, OUT(WHY.colour)],
];

// ------------------------------------------------------------------ per-kind specs
// locate(e, M) -> located model object or null; fields: rule table; recordReport: whether a
// record-level "approximated" status covers its fields (false where the reason is generic).
const KIND_SPECS = [
  [/^(Tracks6|Arcs6|Vias6|Pads6|Fills6|Texts6)$/, k => ({locate:(e, M, strict) => LOCATE[k](M, e, strict), fields:PRIMITIVE_FIELDS[k]})],
  [/^(Regions6|ShapeBasedRegions6)$/, k => ({locate:(e, M) => LOCATE[k](M, e), fields:REGION_FIELDS})],
  [/^BoardRegions$/, () => ({locate:() => null, fields:REGION_FIELDS})],
  [/^(ComponentBodies6|ShapeBasedComponentBodies6)$/, k => ({locate:(e, M) => LOCATE[k](M, e), fields:BODY_FIELDS})],
  [/^Texts$/, () => ({outside:WHY.legacyText})],
  [/^Connections6$/, () => ({outside:WHY.ratsnest})],
  [/^(Pin Swap Options6|Advanced Placer Options6)$/, () => ({outside:WHY.tool})],
  [/^SimbeorCacheSection$/, () => ({outside:WHY.solver})],
  [/\/Header$/, () => ({outside:WHY.file})],
  [/\/Data \(empty\)$/, () => ({outside:"An empty stream: it holds no record, so there is nothing to carry."})],
  [/^(FileHeader|FileHeaderSix|FileVersionInfo)$/, () => ({outside:WHY.file})],
  [/^Components6$/, () => ({
    locate:(e, M) => { const it = M.byId.get(M.srcToId.get(e.id.toLowerCase())); return it ? {obj:it, part:it, layer:it.layer} : null; },
    fields:{...COMMON,
      LAYER:H((v, e, o) => waffleLayer(v) === o.obj.layer || "side"), LOCKED:H((v, e, o) => truthy(v) === (o.obj.locked === true) || (truthy(v) ? "locked in the source, unlocked in Waffle" : "unlocked")),
      PRIMITIVELOCK:H(v => truthy(v) || "primitives editable apart from the component"),
      X:H((v, e, o) => near(o.obj.x, dim(v), 1e-4) || "x"), Y:H((v, e, o) => near(o.obj.y, -dim(v), 1e-4) || "y"),
      ROTATION:H((v, e, o) => sameAngle(-Number(v), o.obj.angle || 0) || "rotation"), PATTERN:H((v, e, o, M) => M.defs.get(o.obj.def)?.footprint?.name === v || "footprint name"),
      HEIGHT:H((v, e, o) => near(o.obj.height, dim(v), 1e-4) || "height"),
      NAMEON:H((v, e, o) => truthy(v) === (o.obj.boardLabels || []).some(l => l.field === "ref") || "designator visibility"),
      COMMENTON:H((v, e, o) => truthy(v) === (o.obj.boardLabels || []).some(l => l.field === "value") || "comment visibility"),
      GROUPNUM:noGroup, UNIONINDEX:noGroup, COUNT:H(v => Number(v) === 0 || "COUNT " + v),
      SOURCEDESIGNATOR:H((v, e, o) => o.obj.ref === v || "designator " + o.obj.ref),
      // The importer derives the part link from SOURCEUNIQUEID (altium-ids.js sourceLink); the census can only see that a link is there.
      SOURCEUNIQUEID:H((v, e, o) => !!(o.obj.altiumSourceId || o.obj.link) || "no schematic link"),
      JUMPERSVISIBLE:OUT(WHY.view),
      CHANNELOFFSET:OUT("Index Altium's ECO assigns from the schematic's channel numbering; it has no effect on a board whose SOURCEHIERARCHICALPATH has a single level.", (v, e) => !String(e.fields.SOURCEHIERARCHICALPATH || "").includes("\\")),
    }})],
  [/^Nets6$/, () => ({
    locate:(e, M) => (M.netNames.has(e.fields.NAME) ? {obj:{name:e.fields.NAME}} : null),
    fields:{...COMMON, NAME:H(() => true), LAYER:OUT(WHY.base, v => /^TOP$/i.test(v)), PRIMITIVELOCK:OUT(WHY.base, v => falsy(v)),
      VISIBLE:OUT(WHY.view), COLOR:OUT(WHY.colour), OVERRIDECOLORFORDRAW:OUT(WHY.colour), JUMPERSVISIBLE:OUT(WHY.view),
      "TOPLAYER_MRWIDTH":OUT(WHY.memory), "MIDLAYER<n>_MRWIDTH":OUT(WHY.memory), "BOTTOMLAYER_MRWIDTH":OUT(WHY.memory),
      MRVIASIZE:OUT(WHY.memory), MRVIAHOLE:OUT(WHY.memory),
      MANHATTANLENGTH:OUT(WHY.computed), ROUTEDLENGTH:OUT(WHY.computed), DELAYTOTAL:OUT(WHY.computed), CURRENTTOTAL:OUT(WHY.computed), RESISTANCETOTAL:OUT(WHY.computed)}})],
  [/^Classes6\/KIND=(0)$|^SignalClasses\/KIND=10$|^Classes6\/KIND=(1|6)$/, k => ({
    locate:(e, M) => {
      const name = e.fields.NAME, kind = Number(e.fields.KIND), sig = M.model.signals || {};
      if (truthy(e.fields.SUPERCLASS)) return told(reportOf(M, e)) ? null : {obj:{name}, members:[]};
      if (kind === 1) return M.doc.componentClasses?.[name] ? {obj:{name}, members:M.doc.componentClasses[name]} : null;
      const as = {0:"net", 6:"pair", 10:"xsignal"}[kind], tag = (sig.tags || []).find(t => t.name === name && t.as?.[as]);
      if (!tag) return null;
      const members = kind === 0 ? Object.entries(sig.nets || {}).filter(([, n]) => (n.tags || []).includes(name)).map(([n]) => n)
        : kind === 6 ? (sig.signals || []).filter(s => (s.tags || []).includes(name)).map(s => s.name)
          : M.xsignals.filter(p => (p.tags || []).includes(name)).map(p => p.name);
      return {obj:tag, members};
    }, fields:CLASS_FIELDS})],
  [/^(Classes6|SignalClasses)\/KIND=/, () => ({locate:() => null, fields:CLASS_FIELDS})],
  [/^DifferentialPairs6$/, () => ({
    locate:(e, M) => { const s = (M.model.signals?.signals || []).find(x => x.kind === "diff" && x.name === e.fields.NAME); return s ? {obj:s} : null; },
    fields:{...COMMON, NAME:H(() => true), LAYER:OUT(WHY.base, v => /^TOP$/i.test(v)),
      POSITIVENETNAME:H((v, e, o) => o.obj.legs.some(l => l.polarity > 0 && l.nets.includes(v)) || "positive net"),
      NEGATIVENETNAME:H((v, e, o) => o.obj.legs.some(l => l.polarity < 0 && l.nets.includes(v)) || "negative net"),
      GATHERCONTROL:H(v => falsy(v) || "gather control")}})],
  [/^Polygons6$/, () => ({
    locate:(e, M) => { const it = M.byId.get(M.srcToId.get(e.id.toLowerCase())); return it ? {obj:it, layer:it.layer, net:it.net} : null; },
    fields:{...COMMON, LAYER:textLayerRule, LOCKED:lockRule, PRIMITIVELOCK:H(v => truthy(v) || "editable pour primitives"),
      NET:H((v, e, o, M) => o.obj.net === M.netList[+v] || "net"), NAME:H((v, e, o) => o.obj.name === chars(v) || "name"),
      POLYGONTYPE:H(v => /^Polygon$/i.test(v) || "polygon type " + v), POURINDEX:H((v, e, o) => Number(v) === o.obj.pourIndex || "pour order"),
      REMOVEDEAD:H((v, e, o) => truthy(v) === o.obj.removeDeadCopper || "dead copper"), POUROVER:H((v, e, o) => truthy(v) === o.obj.pourOverSameNet || "pour over"),
      POUROVERSTYLE:H((v, e, o) => o.obj.sourcePourOver?.style === Number(v) || "pour-over style " + v + " not kept (sourcePourOver " + JSON.stringify(o.obj.sourcePourOver) + ")"),
      GRIDSIZE:H((v, e, o) => near(o.obj.hatchPitch, dim(v), 1e-4) || "hatch pitch"), TRACKWIDTH:H((v, e, o) => near(o.obj.hatchWidth, dim(v), 1e-4) || "hatch width"),
      HATCHSTYLE:H((v, e, o) => (/^Solid$/i.test(v) ? !o.obj.fillMode || o.obj.fillMode === "solid" : /^None$/i.test(v) ? o.obj.fillMode === "outline" : o.obj.fillMode === "hatched") || "hatch style"),
      MINPRIMLENGTH:H((v, e, o) => near(o.obj.minPrimLength, dim(v), 1e-4) || "minimum primitive length"),
      ARCRESOLUTION:H((v, e, o) => near(o.obj.arcApproximation, Math.max(.0005, dim(v)), 1e-4) || "arc approximation"),
      REMOVEISLANDSBYAREA:H((v, e, o) => truthy(v) === (o.obj.islandAreaThreshold != null) || "island removal"),
      AREATHRESHOLD:H((v, e, o) => !truthy(e.fields.REMOVEISLANDSBYAREA) || near(o.obj.islandAreaThreshold, Number(v) * TICK * TICK, 1e-6) || "island area"),
      REMOVENECKS:H((v, e, o) => truthy(v) === (o.obj.neckWidth != null) || "neck removal"),
      NECKWIDTHTHRESHOLD:H((v, e, o) => !truthy(e.fields.REMOVENECKS) || near(o.obj.neckWidth, dim(v), 1e-4) || "neck width"),
      SHELVED:H((v, e, o) => truthy(v) === !!o.obj.shelved || "shelved"),
      "VX<n>":H((v, e, o, M, f, raw) => o.obj.points.some(p => near(p[0], dim(v), 1e-4)) || "outline"), "VY<n>":H((v, e, o, M, f, raw) => o.obj.points.some(p => near(p[1], -dim(v), 1e-4)) || "outline"),
      "KIND<n>":H((v, e, o) => Number(v) === 0 || !!o.obj.regionShape || "arc edge"),
      "CX<n>":H((v, e, o, M, f, raw) => Number(e.fields["KIND" + /\d+/.exec(raw)[0]]) === 0 || !!o.obj.regionShape), "CY<n>":H((v, e, o, M, f, raw) => Number(e.fields["KIND" + /\d+/.exec(raw)[0]]) === 0 || !!o.obj.regionShape),
      "SA<n>":H((v, e, o, M, f, raw) => Number(e.fields["KIND" + /\d+/.exec(raw)[0]]) === 0 || !!o.obj.regionShape), "EA<n>":H((v, e, o, M, f, raw) => Number(e.fields["KIND" + /\d+/.exec(raw)[0]]) === 0 || !!o.obj.regionShape),
      "R<n>":H((v, e, o, M, f, raw) => Number(e.fields["KIND" + /\d+/.exec(raw)[0]]) === 0 || !!o.obj.regionShape),
      RESTORELAYER:OUT("Where a shelved pour returns to; only read when SHELVED is TRUE.", (v, e) => !truthy(e.fields.SHELVED)),
      RESTORENET:OUT("The net a shelved pour returns to; only read when SHELVED is TRUE.", (v, e) => !truthy(e.fields.SHELVED)),
      USEOCTAGONS:H(v => falsy(v) || "octagons around pads"), IGNOREVIOLATIONS:H(v => falsy(v) || "pour ignores on-line DRC"),
      OPTIMALVOIDROTATION:H(() => "Waffle has no void-rotation setting"),
    }})],
  [/^PrimitiveParameters\/NAME$/, () => ({
    locate:(e, M) => { const part = M.paramOwner(e); const def = part && M.defs.get(part.def); return def ? {obj:def, part} : null; },
    fields:{NAME:H(() => true), VALUE:H((v, e, o) => {
      const name = e.fields.UNICODE__NAME ? chars(e.fields.UNICODE__NAME) : e.fields.NAME, val = e.fields.UNICODE__VALUE ? chars(e.fields.UNICODE__VALUE) : v;
      return o.obj.parameters?.[name] === val || "parameter " + name + " = " + JSON.stringify(o.obj.parameters?.[name]); }),
    "UNICODE__NAME":H(() => true), "UNICODE__VALUE":H(() => true),
    ISIMPORTED:OUT("Marks a parameter Altium's ECO copied from the schematic; the parameter itself is compared.")}})],
  [/^PrimitiveParameters\/PRIMITIVEID$/, () => ({
    locate:(e, M) => { const m = /^Component#(\d+)$/i.exec(e.fields.ID || ""); const part = m && M.byId.get(M.srcToId.get("components6/data#" + m[1]));
      return part && (Number(e.fields.COUNT) === 0 || e.fields.APPURTENANCE == null) ? {obj:part} : null; },
    fields:{PRIMITIVEID:H(() => true), ID:H(() => true), COUNT:H(() => true), VARIANTGUID:H((v, e) => !v || /^System$/i.test(v) && Number(e.fields.COUNT) === 0 || "variant " + v),
      APPURTENANCE:H((v, e) => Number(e.fields.COUNT) === 0 || "vault rows")}})],
  [/^WideStrings6$/, () => ({locate:(e, M) => (M.texts.has(e.fields.TEXT) ? {obj:{}} : null), fields:{INDEX:H(() => true), TEXT:H(() => true)}})],
  [/^Models$/, () => ({
    locate:(e, M) => { const m = (M.doc.bodyModels || []).find(b => b.id === e.fields.ID); return m ? {obj:m} : null; },
    fields:{ID:H(() => true), NAME:H((v, e, o) => o.obj.file === v || "file"), CHECKSUM:H((v, e, o) => o.obj.checksum === (Number(v) >>> 0) || "checksum"),
      EMBED:H((v, e, o) => !truthy(v) || !!o.obj.zlib || "embedded payload"), MODELSOURCE:H(v => /^Undefined$/i.test(v) || "model source " + v),
      ROTX:H((v, e, o, M) => bodyRot(M, e, 0, v)), ROTY:H((v, e, o, M) => bodyRot(M, e, 1, v)), ROTZ:H((v, e, o, M) => bodyRot(M, e, 2, v)),
      // Each body that places the model stores its own MODEL.3D.DZ (compared in ComponentBodies6). Where the source's bodies all differ from this copy, the copy places nothing.
      DZ:H((v, e, o, M) => M.bodies.some(b => b.modelId === e.fields.ID && near(b.dz ?? 0, dim(v), 1e-3)) ||
        (M.sourceBodyDz(e.fields.ID).length && M.sourceBodyDz(e.fields.ID).every(z => !near(z, dim(v), 1e-3)) ? {outside:"The model's own copy of an offset that every body using it overrides with its MODEL.3D.DZ."} : "dz"))}})],
  [/^Models\/<n>$/, () => ({locate:(e, M) => (M.modelPayload(e) ? {obj:{}} : null)})],
  [/^Rules6\/RULEKIND=/, k => ({
    recordReport:true,
    locate:(e, M) => { const r = (M.model.rules?.list || []).find(x => x.origin?.kind === "import" && x.origin.record === e.extra.index + 1 && x.name === e.fields.NAME); return r ? {obj:r} : null; },
    fields:new Proxy(RULE_FIELDS, {get:(t, f) => t[f] ?? (/^[A-Z]/.test(f) ? H((v, e, o) => ruleValue(f, v, o.obj, k.split("=")[1])) : undefined)})})],
  [/^Board6$/, () => ({recordReport:false, locate:(e, M) => ({obj:M.doc}), fields:new Proxy({}, {get:(t, f) => boardFieldRule(f)})})],
];
function bodyRot(M, e, axis, v) { return M.bodies.some(b => b.modelId === e.fields.ID && sameAngle(+v, b.rotation?.[axis] ?? 0)) || "rotation"; }
function specFor(kind) { for (const [re, make] of KIND_SPECS) if (re.test(kind)) return make(kind); return {}; }
const norm = f => f.replace(/([23])D(?=\.|CONFIG|VIEW|3D|$)/g, (_, d) => (d === "2" ? "\u00a7A" : "\u00a7B")).replace(/(?<![V])\d+/g, "<n>").replace(/\u00a7A/g, "2D").replace(/\u00a7B/g, "3D").replace(/^V9_STACK_LAYER<n>_\{[^}]*\}/, "V9_STACK_LAYER<n>_{substack}").replace(/^V9_CACHE_LAYER<n>_\{[^}]*\}/, "V9_CACHE_LAYER<n>_{substack}").replace(/^LAYER_V8_<n>_\{[^}]*\}/, "LAYER_V8_<n>_{substack}");

// ------------------------------------------------------------------ account
function account(entries, imported, files) {
  const M = modelIndex(imported, files);
  // Context the rules need: the source's own tables.
  const boardE = entries.find(e => e.kind === "Board6") || {fields:{}};
  M.chain = stackNames(boardE.fields).chain;
  M.netList = entries.filter(e => e.kind === "Nets6").map(e => e.fields.NAME);
  // A primitive names its component by record index (two components may share a SOURCEDESIGNATOR).
  M.ownerOf = e => (e.extra.comp == null ? null : M.byId.get(M.srcToId.get("components6/data#" + e.extra.comp)) || null);
  M.xsignals = (M.model.signals?.signals || []).flatMap(s => s.paths || []);
  const bodyDz = new Map();
  for (const e of entries) if (/ComponentBodies6$/.test(e.kind) && e.fields.MODELID) (bodyDz.get(e.fields.MODELID) || bodyDz.set(e.fields.MODELID, []).get(e.fields.MODELID)).push(dim(e.fields["MODEL.3D.DZ"]));
  M.sourceBodyDz = id => bodyDz.get(id) || [];
  M.bodies = M.items.flatMap(i => i.bodies3d || []);
  M.usedLayers = new Set(M.prims.map(p => p.layer).concat(M.bodies.map(b => b.layer)));
  // MID<n> is slot n + 1 of the fixed layer table, PLANE<n> slot n + 38; a slot's place in the stack chain is its Waffle inner layer.
  const slot = name => { const n = String(name || "").toLowerCase().replace(/[ _-]/g, ""); let m = /^mid(?:layer)?(\d+)/.exec(n); if (m) return +m[1] + 1; m = /^(?:internal)?plane(\d+)/.exec(n); return m ? +m[1] + 38 : 0; };
  M.layerKey = name => { const pos = M.chain.indexOf(slot(name)); return pos > 0 ? "Inner " + pos : waffleLayer(name); };
  M.hasLayer = f => !slot(f) || M.chain.includes(slot(f));
  let owner = null;
  const paramRows = new Map();
  for (const e of entries) {
    if (e.kind === "PrimitiveParameters/PRIMITIVEID") { const m = /^Component#(\d+)$/i.exec(e.fields.ID || ""); owner = m && e.fields.APPURTENANCE == null ? M.byId.get(M.srcToId.get("components6/data#" + m[1])) : null; }
    else if (e.kind === "PrimitiveParameters/NAME") paramRows.set(e, owner);
  }
  M.paramOwner = e => paramRows.get(e) || null;
  M.modelPayload = e => {
    const want = e.extra.bytes;
    return (M.doc.bodyModels || []).some(m => { if (!m.zlib) return false; const b = Buffer.from(m.zlib, "base64"); return b.length === want.length && b.equals(Buffer.from(want)); });
  };

  const kinds = new Map();
  for (const e of entries) { if (!kinds.has(e.kind)) kinds.set(e.kind, []); kinds.get(e.kind).push(e); }
  const rows = [];
  for (const [kind, list] of kinds) {
    const spec = specFor(kind);
    const objMetric = {source:0, held:0, reported:0, outside:0, lost:0, unmapped:0}, objDetail = [];
    const fieldRows = new Map();  // normalized field -> {metric, detail}
    const located = new Map();
    if (spec.locate) for (const strict of [true, false]) for (const e of list) {
      if (located.get(e)) continue;
      try { located.set(e, spec.locate(e, M, strict) || null); } catch (error) { located.set(e, null); if (!strict) objDetail.push(e.id + ": locate failed " + error.message); }
    }
    for (const e of list) {
      const rep = reportOf(M, e), o = located.get(e) || null;
      objMetric.source++;
      if (o) objMetric.held++;
      else if (told(rep)) objMetric.reported++;
      else if (spec.outside) objMetric.outside++;
      else if (!spec.locate) { objMetric.unmapped++; if (objDetail.length < 6) objDetail.push(e.id + ": unmapped: the census has no rule for this kind of record"); }
      else { objMetric.lost++; if (objDetail.length < 6) objDetail.push(e.id + (rep ? " (report: " + rep.status + ")" : "") + " not found in the model"); }
      const recordTold = told(rep) && (rep.status !== "approximated" || spec.recordReport !== false);
      for (let [f, v] of Object.entries(e.fields)) {
        const nf = norm(f);
        if (!fieldRows.has(nf)) fieldRows.set(nf, {metric:{source:0, held:0, reported:0, outside:0, lost:0, unmapped:0, unplaced:0}, detail:[]});
        const row = fieldRows.get(nf); row.metric.source++;
        if (spec.outside) { row.metric.outside++; continue; }
        // UNICODE__<FIELD> is the same text as <FIELD> in UTF-16 code points: the base field's rule decides, on the decoded text.
        const twin = /^UNICODE__(.+)$/.exec(f), own = spec.fields?.[nf] ?? spec.fields?.[f];
        const rule = f === "UNICODE" && !own ? OUT(WHY.twinMarker) : !own && twin ? spec.fields?.[norm(twin[1])] ?? spec.fields?.[twin[1]] : own;
        if (!own && twin) v = chars(v);
        let held = false, reported = false, outsideWhy = null, unmapped = null, why = "the model holds a different value";
        if (rule?.held && o) {
          try { const r = rule.held(v, e, o, M, nf, f); held = r === true; if (r?.outside) outsideWhy = r.outside; else if (r?.reported) reported = true; else if (r?.unmapped) unmapped = r.unmapped; else if (!held) why = typeof r === "string" ? r : "value differs"; }
          catch (error) { why = "compare failed: " + error.message; }
        } else if (!rule) unmapped = "the census has no rule for this field, so nothing has checked it";
        else if (!rule.held) unmapped = "outside on other records for a reason that does not apply to this one; the census has no comparison for it";
        const note = how => { if (row.detail.length < 4) row.detail.push(e.id + " " + f + "=" + JSON.stringify(v).slice(0, 60) + ": " + how); };
        if (held) row.metric.held++;
        else if (recordTold || reported) row.metric.reported++;
        else if (outsideWhy || rule?.outside && (!rule.when || rule.when(v, e, f, M, nf))) row.metric.outside++;
        else if (unmapped) { row.metric.unmapped++; note("unmapped: " + unmapped); }
        else if (rule.held && !o) row.metric.unplaced++;  // its object is the failure; the object row counts it once
        else { row.metric.lost++; note(why); }
      }
    }
    rows.push({id:kind, pass:objMetric.lost + objMetric.unmapped === 0, gating:true, metric:objMetric, detail:objDetail});
    for (const [nf, r] of fieldRows) rows.push({id:kind + "." + nf, pass:r.metric.lost + r.metric.unmapped === 0, gating:true, metric:r.metric, detail:r.detail});
  }
  return rows;
}

module.exports = {FIXTURES, census, account};

// node tests/e2e/census-altium.cjs: print the census inventory (kinds, fields, sample values).
if (require.main === module) {
  const fs = require("node:fs"), path = require("node:path"), root = path.join(__dirname, "../..");
  for (const fx of FIXTURES) {
    const files = fx.files.map(f => ({name:path.basename(f), bytes:new Uint8Array(fs.readFileSync(path.join(root, f)))}));
    const kinds = new Map();
    for (const e of census(files)) {
      if (!kinds.has(e.kind)) kinds.set(e.kind, {n:0, fields:new Map()});
      const k = kinds.get(e.kind); k.n++;
      for (const [f, v] of Object.entries(e.fields)) {
        const nf = norm(f);
        if (!k.fields.has(nf)) k.fields.set(nf, {n:0, vals:new Set()});
        const x = k.fields.get(nf); x.n++; if (x.vals.size < 3) x.vals.add(String(v).slice(0, 30));
      }
    }
    console.log("== " + fx.id);
    for (const [kind, k] of kinds) console.log(kind + " (" + k.n + "): " + [...k.fields].map(([f, x]) => f + "×" + x.n + "[" + [...x.vals].join(";") + "]").join(" "));
  }
}
