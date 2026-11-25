"use strict";
// Margin certificates for copper-to-copper Clearance (lazy, with
// drc-view.js). The online DRC keeps one store per open board.
//
// A certificate is a proven lower bound L on the distance between two copper features of different
// nets; with the pair's required gap g its margin is L - g. An edit that moves or grows a feature by
// at most d (Hausdorff distance between its old and new shape) cannot bring any pair closer than
// L - d, so only pairs with L - d < g get the exact narrow phase again; every other certificate is
// advanced by subtracting d and stays a proof.
//
// Pairs farther apart than reach + SLACK (reach: the largest gap any Clearance rule asks for when
// the store is built) are not stored: "no certificate" certifies at least reach + SLACK. Each item
// carries its drift, the displacement since its last local broad phase; while every drift is at
// most SLACK/4 an unstored pair is at least reach + SLACK/2 apart, which proves it under any gap up
// to reach + SLACK/2, so a rule may be tightened by up to SLACK/2 without a new broad phase. An item
// whose drift would pass SLACK/4, or whose net, layer, kind, size, pin or feature count changed, is
// re-queried (local broad phase over a grid of feature boxes, exact narrow phase on its neighbours).
//
// A rule edit needs no geometry while the stored distances are exact and the new reach stays in the
// band: the new verdict is L against the new gap, per stored pair (setRules).
//
// Results are AtriumRules.drc's Clearance results for copper pairs, one for one: the same rule per
// pair (clearanceRule), the same gap (clearanceGap), the same distance and location (pieceGap, measured in
// the orientation the batch DRC visits the pair: board order), one result per object pair (the
// closest), net ties skipped. Not covered (the caller runs them): keep-outs, stale teardrops and the
// hole cells of the clearance matrix (supports() is false for rule sets with hole cells).
//
// The store is built from one extraction of the board (AtriumRules.kit), then edits re-extract only
// the changed items.
globalThis.AtriumDRCCerts = (() => {
  const VERSION = 1;
  const K = () => globalThis.AtriumRules.kit, AR = () => globalThis.AtriumRules;
  const EXACT = 1, DEAD = 2;
  class Grow {
    constructor(T, n = 1024) {this.T = T; this.a = new T(n); this.n = 0;}
    push(v) {if (this.n === this.a.length) {const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b;} this.a[this.n++] = v; return this.n - 1;}
    get bytes() {return this.n * this.a.BYTES_PER_ELEMENT;}
  }
  // Hausdorff bound between a feature and its edited copy with the same number of core points: the
  // largest point displacement plus the radius change, including shrinkage.
  function displacement(a, b) {
    if (a.pieces || b.pieces) {
      const pa = a.pieces || [a], pb = b.pieces || [b];
      if (pa.length !== pb.length) return Infinity;
      let d = 0; for (let k = 0; k < pa.length; k++) d = Math.max(d, displacement(pa[k], pb[k])); return d;
    }
    if (a.core.length !== b.core.length) return Infinity;
    let d = 0;
    for (let k = 0; k < a.core.length; k++) d = Math.max(d, Math.hypot(a.core[k][0] - b.core[k][0], a.core[k][1] - b.core[k][1]));
    return d + Math.abs(b.radius - a.radius);
  }
  // A change to this feature identity re-queries its neighbours. Rule scopes can
  // also read authored fields on the item, even when its feature is unchanged.
  const shape = f => f.net + "|" + f.span[0] + "," + f.span[1] + "|" + f.ck + "|" + f.kind + "|" + (f.component ?? "") + "|" + (f.layer ?? "") + "|" + (f.pin ?? "") +
    "|" + (f.drill ?? "") + "|" + (f.diameter ?? "") + "|" + (f.width ?? "") + "|" + (f.padKind ?? "") + "|" + f.label + "|" + f.id;
  const boxGap = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
  // rules.js sideSpan(): the copper span of a layer name.
  function sideSpan(layer) {
    if (layer == null || layer === "Multi") return [0, 127];
    const n = K().copperIndex(layer); if (n != null) return [n, n];
    if (/^top|^silk$/i.test(layer)) return [0, 0]; if (/^bottom/i.test(layer)) return [127, 127];
    return null;
  }
  const holeCells = CR => CR.some(r => r.objects && Object.keys(r.objects).some(k => k.endsWith("-hole")));
  // Whether the store gives the whole copper-pair part of Clearance under these rules.
  function supports(doc, rules, project, defs) {const R=AR().compiled(doc,{rules,project,defs}); return !holeCells(R.byType.clearance) && !R.byType.clearance.some(r=>r.measured) && !R.diagnostics.some(d=>d.type==="clearance");}
  // The batch DRC's copper-pair Clearance results among a list (the rest: keep-outs, teardrops, holes).
  const isPair = v => v.type === "clearance" && v.what === undefined && !v.stale && v.otherId != null;

  // The store, built in steps (an iterator: each next() is one step of at most about CHUNK items or
  // features; the result is the store). create() runs every step at once.
  const CHUNK = 4096;
  function create(doc, defs, rules, o) {const it = building(doc, defs, rules, o); for (;;) {const r = it.next(); if (r.done) return r.value;}}
  function* building(doc, defs, rules, {slack = .5, project = null} = {}) {
    const X = K();
    let work = 0, t0 = performance.now();
    const pause = () => {work += performance.now() - t0;}, resume = () => {t0 = performance.now();};
    const compile = rules => AR().compiled(doc,{rules,project,defs});
    const readsSubject = rules => rules.some(r => !X.allScope(r.scope) || !X.allScope(r.scope2));
    let R = compile(rules), set = R.set, CR = R.byType.clearance, scoped = readsSubject(CR);
    const reach = Math.max(0, ...CR.map(X.clearanceMax)), band = reach + slack;
    let drcReach = Math.max(0, ...CR.map(X.clearanceMax));
    // Per feature: the feature, its item id, its place in the item, its object (pad, track: the batch
    // DRC reports one result per object pair), its pairs, and whether it is current.
    const feats = [], featItem = [], featOrd = [], featObj = [], featPairs = [], alive = [];
    let objects = 0;
    const byItem = new Map(), drift = new Map(), seq = new Map();
    let nextSeq = 0;
    // Pairs (structure of arrays): feature indices (lower board order first when certified), distance
    // lower bound, required gap, rule index, flags; the closest point of exact pairs.
    const PA = new Grow(Int32Array), PB = new Grow(Int32Array), PL = new Grow(Float64Array), PG = new Grow(Float64Array), PR = new Grow(Uint16Array), PF = new Grow(Uint8Array), PAT = [];
    let ruleIndex = new Map(CR.map((r, k) => [r, k]));
    const stats = {narrow: 0, boxOnly: 0, requeries: 0, advanced: 0, rechecked: 0, arithmetic: 0, resolved: 0};
    let out = null; // cached violations()
    // Net ties (net-ties.js): copper a tie joins is not checked; re-read when a tie part changes.
    const NT = () => globalThis.AtriumNetTies;
    let ties = NT()?.drcTies?.(doc, defs) || null;
    const tiePart = i => !!i && !!NT()?.isTiePart?.(i, defs);
    // ---- uniform grid over feature boxes (local broad phase)
    let size = Math.max(reach, .05), indexed = false;
    const cells = new Map(), OFF = 1048576, SPAN = 2097152, key = (x, y) => (x + OFF) * SPAN + (y + OFF), cell = v => Math.floor(v / size);
    function cellsOf(b, grow, fn) {
      const x0 = cell(b[0] - grow), y0 = cell(b[1] - grow), x1 = cell(b[2] + grow), y1 = cell(b[3] + grow);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 65536) {for (const c of cells.values()) fn(c); return;}
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {const c = cells.get(key(x, y)); if (c) fn(c);}
    }
    function gridEach(f, fn) {
      const b = feats[f].box, x0 = cell(b[0]), y0 = cell(b[1]), x1 = cell(b[2]), y1 = cell(b[3]);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 65536) {fn(-1); return;} // huge: kept in the "everywhere" list
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(key(x, y));
    }
    const EVERY = -1;
    function gridAdd(f) {gridEach(f, k => {let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(f);});}
    function gridRemove(f) {gridEach(f, k => {const c = cells.get(k); if (c) {const i = c.indexOf(f); if (i >= 0) {c[i] = c[c.length - 1]; c.pop();}}});}
    // ---- certificates
    function need(a, b) {
      const r = R.clearanceRule(a, b); if (!r) return null;
      return {r, g: X.clearanceGap(r, a.ck, b.ck)};
    }
    const relevant = (a, b) => a.net !== b.net && !(a.span[1] < b.span[0] || b.span[1] < a.span[0]);
    // Board order as far as the store knows it (seq of the item, then the feature's place in it);
    // violations() checks the real order and re-measures a pair whose order changed.
    const before = (i, j) => {const si = seq.get(featItem[i]), sj = seq.get(featItem[j]); return si < sj || si === sj && featOrd[i] < featOrd[j];};
    const NONE = 0xffff, bad = p => !(PF.a[p] & DEAD) && PL.a[p] + X.EPS < PG.a[p];
    // The exact distance (and closest point, in the stored orientation) of pair p.
    function exact(p, a, b) {
      const m = X.pieceGap(a, b, band);
      PL.a[p] = Math.min(m.d, band); PF.a[p] = m.d < band ? EXACT : 0; PAT[p] = m.d < band ? {at: m.at, d: m.d, swapped: false} : null;
    }
    // Certify one candidate pair: store it unless its boxes alone prove a margin of SLACK. A pair no rule
    // matches is kept too (gap -Infinity, never a violation), so a rule edit that matches it later is
    // answered from the store.
    function certify(i, j) {
      if (!before(i, j)) [i, j] = [j, i];
      const a = feats[i], b = feats[j];
      if (!relevant(a, b)) return;
      const bg = boxGap(a.box, b.box);
      if (bg >= band) return; // no certificate: distance >= reach + SLACK
      const n = need(a, b);
      const p = PA.push(i); PB.push(j); PL.push(0); PG.push(n ? n.g : -Infinity); PR.push(n ? ruleIndex.get(n.r) : NONE); PF.push(0); PAT[p] = null;
      if (!n || bg >= n.g) {PL.a[p] = Math.max(0, bg); stats.boxOnly++;} // the box gap is a proof, not exact
      else {exact(p, a, b); stats.narrow++; if (bad(p)) out = null;}
      featPairs[i].push(p); featPairs[j].push(p);
    }
    function recheck(p) {exact(p, feats[PA.a[p]], feats[PB.a[p]]); stats.narrow++; stats.rechecked++;}
    function kill(p) {if (bad(p)) out = null; PF.a[p] |= DEAD;}
    function killPairs(f) {
      for (const p of featPairs[f]) if (!(PF.a[p] & DEAD)) {kill(p); const o = PA.a[p] === f ? PB.a[p] : PA.a[p], l = featPairs[o], k = l.indexOf(p); if (k >= 0) {l[k] = l[l.length - 1]; l.pop();}}
      featPairs[f] = [];
    }
    // Local broad phase for an item's features against the grid.
    function query(fs) {
      stats.requeries++;
      for (const i of fs) {
        const seen = new Set(), b = feats[i].box;
        const visit = c => {for (const j of c) if (j !== i && !seen.has(j) && alive[j]) {seen.add(j); if (featItem[j] === featItem[i] && featOrd[j] < featOrd[i]) continue; if (boxGap(b, feats[j].box) < band) certify(i, j);}};
        cellsOf(b, band, visit);
        const every = cells.get(EVERY); if (every) visit(every);
      }
    }
    function featuresOf(item) {return X.extract({...doc, items: [item]}, defs).copper.filter(f => f.net);}
    function addFeatures(id, list) {
      const obj = new Map();
      const fs = list.map((f, k) => {
        const n = feats.length; let o = obj.get(f.obj); if (o === undefined) obj.set(f.obj, o = objects++);
        feats.push(f); featItem.push(id); featOrd.push(k); featObj.push(o); featPairs.push([]); alive.push(true); return n;
      });
      byItem.set(id, fs); drift.set(id, 0);
      if (indexed) for (const f of fs) gridAdd(f);
      return fs;
    }
    function removeItem(id) {
      for (const f of byItem.get(id) || []) {killPairs(f); gridRemove(f); alive[f] = false;}
      byItem.delete(id); drift.delete(id);
    }
    // ---- build: the board's copper features (extracted CHUNK items at a time), then the batch DRC's
    // broad phase at reach + SLACK over the grid, CHUNK features at a time.
    const list = doc.items.slice();
    for (let k = 0; k < list.length; k += CHUNK) {
      const part = list.slice(k, k + CHUNK), groups = new Map();
      for (const f of X.extract({...doc, items: part}, defs).copper) if (f.net) {let g = groups.get(f.id); if (!g) groups.set(f.id, g = []); g.push(f);}
      for (const i of part) {seq.set(i.id, nextSeq++); const g = groups.get(i.id); if (g) addFeatures(i.id, g);}
      pause(); yield; resume();
    }
    const featuresMs = work;
    {
      const sample = [], stride = Math.max(1, Math.floor(feats.length / 1024));
      for (let i = 0; i < feats.length; i += stride) {const b = feats[i].box; sample.push(Math.max(b[2] - b[0], b[3] - b[1]));}
      sample.sort((a, b) => a - b); size = Math.max(sample[Math.floor(sample.length * .75)] || 0, reach, .05);
    }
    for (let f = 0; f < feats.length; f++) gridAdd(f);
    indexed = true;
    stats.candidates = 0;
    if (CR.length) {
      const stamp = new Int32Array(feats.length).fill(-1), every = cells.get(EVERY) || [];
      for (let k = 0; k < feats.length; k += CHUNK) {
        for (let i = k; i < Math.min(feats.length, k + CHUNK); i++) {
          const b = feats[i].box;
          const visit = c => {for (const j of c) if (j > i && stamp[j] !== i) {stamp[j] = i; if (boxGap(b, feats[j].box) < band) {stats.candidates++; certify(i, j);}}};
          cellsOf(b, band, visit); visit(every);
        }
        pause(); yield; resume();
      }
    }
    pause();
    const build = {ms: work, featuresMs, pairsMs: work - featuresMs};

    // ---- edits
    // changed: ids of items whose content changed (the undo journal's ids); items: id -> item (missing
    // = deleted). Item order: a new item goes last (as an added object does); violations() re-checks it.
    let tiesChanged = false;
    function update(changed, items) {
      const t = performance.now(), was = {...stats};
      tiesChanged = false;
      for (const id of changed) {
        const item = items.get(id), old = byItem.get(id);
        if (tiePart(item) || ties?.has(id)) {ties = NT()?.drcTies?.(doc, defs) || null; out = null; tiesChanged = true;}
        if (item && !seq.has(id)) seq.set(id, nextSeq++);
        if (!item) {if (old) removeItem(id); seq.delete(id); continue;}
        if (!old) {const list = featuresOf(item); if (list.length) query(addFeatures(id, list)); continue;}
        const next = featuresOf(item);
        let d = next.length === old.length ? 0 : Infinity;
        for (let k = 0; k < next.length && d < Infinity; k++) {const a = feats[old[k]]; if (shape(a) !== shape(next[k])) d = Infinity; else d = Math.max(d, displacement(a, next[k]));}
        const total = (drift.get(id) || 0) + d;
        if (d === Infinity || total > slack / 4) {removeItem(id); if (next.length) query(addFeatures(id, next)); continue;}
        drift.set(id, total);
        const unchanged = d === 0 && next.every((f, k) => f.box.every((v, n) => v === feats[old[k]].box[n]));
        for (let k = 0; k < old.length; k++) {
          if (!unchanged) gridRemove(old[k]);
          feats[old[k]] = next[k];
          if (!unchanged) gridAdd(old[k]);
        }
        if (unchanged && !scoped) {
          // Results are reported in board order, which can change even when copper does not.
          if (out && old.some(f => featPairs[f].some(bad))) out = null;
          continue;
        }
        // An authored field can change the winning rule without moving copper.
        // A moved feature also updates the distance bound. Keep exact distances for unchanged pairs.
        const touched = new Set();
        for (const f of old) for (const p of featPairs[f]) touched.add(p);
        for (const p of touched) {
          const a = feats[PA.a[p]], b = feats[PB.a[p]], n = need(a, b), was = bad(p);
          stats.resolved++;
          PG.a[p] = n ? n.g : -Infinity; PR.a[p] = n ? ruleIndex.get(n.r) : NONE;
          if (!unchanged) {
            // Both ends on this item (pads of one part on different nets): the gap can close by 2d.
            PL.a[p] = Math.max(0, PL.a[p] - d * ((featItem[PA.a[p]] === id) + (featItem[PB.a[p]] === id))); PF.a[p] &= ~EXACT;
          }
          if (!(PF.a[p] & EXACT) && PL.a[p] < PG.a[p] + 1e-9) recheck(p);
          else if (!unchanged) stats.advanced++;
          if (was || bad(p)) out = null;
        }
      }
      return {ms: performance.now() - t, narrow: stats.narrow - was.narrow, rechecked: stats.rechecked - was.rechecked, advanced: stats.advanced - was.advanced, requeries: stats.requeries - was.requeries, resolved: stats.resolved - was.resolved};
    }
    // A rule edit: resolve each stored pair's rule and gap again. Exact distances give the verdict by
    // arithmetic; inexact (box or clipped) bounds below the new gap get the narrow phase. A new reach
    // beyond reach + SLACK/2, or hole cells, need a rebuild ({rebuild: true}; the store is unchanged).
    function setRules(next) {
      const t = performance.now(), c = compile(next), CR2 = c.byType.clearance;
      const reach2 = Math.max(0, ...CR2.map(X.clearanceMax));
      if (reach2 > reach + slack / 2 + 1e-9) return {rebuild: true, ms: performance.now() - t, reason: "new reach " + reach2 + " > stored " + reach + " + SLACK/2"};
      if (CR2.some(r=>r.measured) || c.diagnostics.some(d=>d.type==="clearance")) return {rebuild:true,ms:performance.now()-t,reason:"scope must read the current measurement"};
      if (holeCells(CR2)) return {rebuild: true, ms: performance.now() - t, reason: "hole cells"};
      if (!CR.length && CR2.length) return {rebuild: true, ms: performance.now() - t, reason: "Clearance was off when the store was built"};
      const idx2 = new Map(CR2.map((r, k) => [r, k]));
      let arithmetic = 0, narrow = 0;
      for (let p = 0; p < PA.n; p++) {
        if (PF.a[p] & DEAD) continue;
        const a = feats[PA.a[p]], b = feats[PB.a[p]], r = c.clearanceRule(a, b);
        if (!r) {PG.a[p] = -Infinity; PR.a[p] = NONE; arithmetic++; continue;}
        const g = X.clearanceGap(r, a.ck, b.ck);
        PG.a[p] = g; PR.a[p] = idx2.get(r);
        if (PF.a[p] & EXACT || PL.a[p] >= g) arithmetic++; else {exact(p, a, b); narrow++; stats.narrow++;}
      }
      R = c; CR = CR2; set = c.set; scoped = readsSubject(CR); ruleIndex = idx2; rules = next; drcReach = reach2; out = null;
      stats.arithmetic += arithmetic;
      return {ms: performance.now() - t, arithmetic, narrow};
    }
    // Find the current board order of the items in the violating pairs.
    function positions(ids) {
      const pos = new Map();
      if (!ids.size) return pos;
      const list = doc.items;
      // For a sparse local result, confirm the saved positions directly. Inserts, deletes and
      // reorders can shift them, even when the edited item's own copper is unchanged.
      if (ids.size * 4 < list.length) {
        for (const id of ids) {
          const k = seq.get(id);
          if (list[k]?.id !== id) break;
          pos.set(id, k);
        }
        if (pos.size === ids.size) return pos;
        pos.clear();
      }
      for (let k = 0; k < list.length; k++) if (ids.has(list[k].id)) pos.set(list[k].id, k);
      return pos;
    }
    // The batch DRC's broad phase visits "big" features (boxes over 4096 grid cells) first in their pairs;
    // its grid size follows the board's feature sizes, so it is worked out only when a violation could hold one.
    function bigTest(list) {
      const s0 = Math.max(drcReach, .05), may = f => (Math.floor(f.box[2] / s0) - Math.floor(f.box[0] / s0) + 1) * (Math.floor(f.box[3] / s0) - Math.floor(f.box[1] / s0) + 1) > 4096;
      if (!list.some(p => may(feats[PA.a[p]]) || may(feats[PB.a[p]]))) return () => false;
      const order = [], pos = positions(new Set(byItem.keys()));
      for (const [id, fs] of byItem) order.push([pos.get(id) ?? Infinity, fs]);
      order.sort((a, b) => a[0] - b[0]);
      const F = order.flatMap(x => x[1]), n = F.length, sample = [], stride = Math.max(1, Math.floor(n / 1024));
      for (let i = 0; i < n; i += stride) {const b = feats[F[i]].box; sample.push(Math.max(b[2] - b[0], b[3] - b[1]));}
      sample.sort((a, b) => a - b);
      const s = Math.max(sample[Math.floor(sample.length * .75)] || 0, drcReach, .05), c = v => Math.floor(v / s);
      return f => {const b = feats[f].box; return (c(b[2]) - c(b[0]) + 1) * (c(b[3]) - c(b[1]) + 1) > 4096;};
    }
    // Violations in AtriumRules.drc's shape: pairs whose exact distance is below the gap, the closest per
    // object pair, measured in board order.
    function violations() {
      if (out) return out;
      const hits = [];
      for (let p = 0; p < PA.n; p++) if (bad(p) && !(ties && ties.skip(feats[PA.a[p]], feats[PB.a[p]]))) hits.push(p);
      return out = format(hits);
    }
    // The results that involve these items (every pair of their objects): what an edit of them changed,
    // unless it changed net ties (then null: take violations()).
    function violationsFor(ids) {
      if (tiesChanged) return null;
      const hits = [], seen = new Set();
      for (const id of ids) for (const f of byItem.get(id) || []) for (const p of featPairs[f]) {
        if (seen.has(p)) continue; seen.add(p);
        if (bad(p) && !(ties && ties.skip(feats[PA.a[p]], feats[PB.a[p]]))) hits.push(p);
      }
      return format(hits);
    }
    function format(hits) {
      const ids = new Set();
      for (const p of hits) {ids.add(featItem[PA.a[p]]); ids.add(featItem[PB.a[p]]);}
      const pos = positions(ids), big = hits.length ? bigTest(hits) : null;
      // Board order of a feature as one number (item position, then its place in the item).
      const order = f => pos.get(featItem[f]) * 65536 + featOrd[f];
      const best = new Map();
      for (const p of hits) {
        let i = PA.a[p], j = PB.a[p];
        const bi = big(i), bj = big(j);
        // The batch DRC's visit: a big feature first when only one is big, else board order.
        const swap = bi !== bj ? bj : order(j) < order(i);
        if (swap) [i, j] = [j, i];
        if (!PAT[p] || PAT[p].swapped !== swap) {
          // Measured in the other orientation: measure again as the batch DRC does (location, last bits).
          const m = X.pieceGap(feats[i], feats[j], PG.a[p]);
          PAT[p] = {at: m.at, d: m.d, swapped: swap};
        }
        const m = PAT[p];
        if (!(m.d + X.EPS < PG.a[p])) continue;
        // One result per object pair (a pad, a whole track): the closest, the first visited on a tie.
        const oa = featObj[i], ob = featObj[j], k = Math.min(oa, ob) * 67108864 + Math.max(oa, ob);
        const v1 = (bi || bj ? 1 : 0), v2 = order(i), v3 = order(j), v = best.get(k);
        if (!v || m.d < v.d || m.d === v.d && (v1 < v.v1 || v1 === v.v1 && (v2 < v.v2 || v2 === v.v2 && v3 < v.v3))) best.set(k, {p, i, j, d: m.d, at: m.at, v1, v2, v3});
      }
      const list = [...best.values()].sort((x, y) => x.v1 - y.v1 || x.v2 - y.v2 || x.v3 - y.v3);
      const ruleSets = !!set.ruleSets, ruleSetOf = AR().ruleSetOf;
      const out = new Array(list.length);
      for (let n = 0; n < list.length; n++) {
        const {p, i, j, d, at} = list[n], a = feats[i], b = feats[j], r = CR[PR.a[p]];
        // AtriumRules.drc's fields, in its order.
        const o = {type: r.type, ruleId: r.id, ruleName: r.name, source: r.label || r.name};
        if (ruleSets) o.ruleSet = ruleSetOf(r);
        o.id = a.id; o.otherId = b.id; o.title = a.label + " ↔ " + b.label; o.actual = d; o.required = PG.a[p]; o.limit = "min"; o.at = at; o.otherAt = at;
        if (r.objects) o.kinds = [a.ck, b.ck];
        out[n] = o;
      }
      return out;
    }
    // The rest of a Clearance result under the store's current rules: keep-outs (the first Clearance rule)
    // and stale teardrops (the rule for their net and layer) keep their geometry; the rule they are
    // reported under is resolved again as AtriumRules.drc does. null for anything else (hole cells).
    function relabel(list) {
      if (!CR.length) return [];
      let byId = null;
      const out = [];
      for (const v of list) {
        let r;
        if (v.what === "Keep-out") r = CR[0];
        else if (v.stale && v.what === "Stale teardrop") {
          byId ??= new Map(doc.items.map(i => [i.id, i]));
          const t = byId.get(v.id), sp = t && sideSpan(t.layer);
          r = t && R.clearanceRule({net: t.net || "", layer: t.layer, span: sp}, {net: "", layer: t.layer, span: sp}) || CR[0];
        } else return null;
        const {type, ruleId, ruleName, source, ruleSet, ...rest} = v;
        const o = {type: r.type, ruleId: r.id, ruleName: r.name, source: r.label || r.name};
        if (set.ruleSets) o.ruleSet = AR().ruleSetOf(r);
        out.push(Object.assign(o, rest));
      }
      return out;
    }
    function memory() {
      let live = 0, adj = 0; for (let p = 0; p < PA.n; p++) if (!(PF.a[p] & DEAD)) live++;
      for (const l of featPairs) adj += l.length;
      return {pairs: PA.n, live, features: feats.length, packedBytes: live * 15 + adj * 4 + feats.length * 4, bytes: PA.bytes + PB.bytes + PL.bytes + PG.bytes + PR.bytes + PF.bytes};
    }
    return {update, setRules, violations, violationsFor, relabel, memory, stats, build, reach, slack, version: VERSION, size: () => feats.length, pairs: () => PA.n};
  }
  return {create, building, supports, isPair, displacement, VERSION};
})();
