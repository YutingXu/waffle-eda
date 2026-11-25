// The standalone kernel instance is also serialised into the pour workers. All its dependencies
// travel with the selected module, so workers need no fetch or filesystem access.
function createAtriumEngine(kind, base64, mode = "auto", asyncCompile = false) {
  const stats = {calls: 0, fallbacks: 0};
  let api = null, memory = null, failure = null, ready = null;

  function decode(text) {
    if (typeof atob === "function") {
      const s = atob(text), out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    const table = new Uint8Array(128);
    for (let i = 0; i < 64; i++) table["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;
    const clean = text.replace(/=+$/, ""), out = new Uint8Array(clean.length * 3 >> 2);
    let bits = 0, value = 0, n = 0;
    for (let i = 0; i < clean.length; i++) {
      value = value << 6 | table[clean.charCodeAt(i) & 127]; bits += 6;
      if (bits >= 8) { bits -= 8; out[n++] = value >> bits & 255; }
    }
    return out;
  }
  function accept(instance) {
    const e = instance.exports;
    if (!(e.memory instanceof WebAssembly.Memory) || e.engine_version() !== 3) throw Error("Unsupported Waffle engine module");
    api = e; memory = e.memory;
  }
  if (base64 && mode !== "js") {
    try {
      const bytes = decode(base64);
      if (asyncCompile && typeof WebAssembly.instantiate === "function")
        ready = WebAssembly.instantiate(bytes, {}).then(r => accept(r.instance)).catch(e => { failure = e; });
      else accept(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
    } catch (error) { failure = error; }
  }

  // Typed views over a fresh buffer: memory may have grown since the last call.
  const f64 = (address, n) => new Float64Array(memory.buffer, address >>> 0, n);
  const u32 = (address, n) => new Uint32Array(memory.buffer, address >>> 0, n);
  const u16 = (address, n) => new Uint16Array(memory.buffer, address >>> 0, n);
  const i32 = (address, n) => new Int32Array(memory.buffer, address >>> 0, n);
  // A trap (out of memory, a bug) may leave the module's heap inconsistent: stop using it.
  function refuse(error) {
    stats.fallbacks++;
    if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) { api = null; failure = error; }
    return null;
  }

  // Size caps (the module checks them again): beyond these the JS fallback runs.
  const EMPTY = new Int32Array(0);
  const MAX_POUR_VALUES = 64 * 1024 * 1024, MAX_ANCHORS = 4_000_000, MAX_KEY_UNITS = 16 * 1024 * 1024;

  // Airwires of every net (connectivity.js airwireEdges) in one call. `nets` holds each net's
  // islands (arrays of entities with kind and anchors [{at, id, label, key}]); `names` the net
  // names. Returns one array of airwires per net, exactly as airwireEdges builds them, or null.
  function airwires(nets, names) {
    if (!api) return null;
    stats.calls++;
    try {
      const anchors = [], island = [], meta = [];
      let units = 0;
      for (const islands of nets) {
        const start = anchors.length;
        if (islands.length >= 2) islands.forEach((group, index) => {
          let pads = false;
          for (const e of group) if (e.kind === "pad") { pads = true; break; }
          for (const e of group) if (!pads || e.kind === "pad") for (const a of e.anchors) {
            anchors.push(a); island.push(index); units += a.key.length;
          }
        });
        meta.push(anchors.length - start, islands.length >= 2 ? islands.length : 0);
      }
      const n = anchors.length;
      if (!n) return nets.map(() => []);
      if (n > MAX_ANCHORS || units > MAX_KEY_UNITS) return refuse();
      const pXY = api.in_f64(0, 2 * n), pIsland = api.in_u32(0, n), pMeta = api.in_u32(1, meta.length),
        pOffsets = api.in_u32(2, n + 1), pUnits = api.in_u16(0, units);
      if (!pXY || !pIsland || !pMeta || !pOffsets || !pUnits) return refuse();
      const xy = f64(pXY, 2 * n), offsets = u32(pOffsets, n + 1), text = u16(pUnits, units);
      u32(pIsland, n).set(island); u32(pMeta, meta.length).set(meta);
      let o = 0;
      for (let i = 0; i < n; i++) {
        const a = anchors[i], key = a.key;
        xy[2 * i] = a.at[0]; xy[2 * i + 1] = a.at[1];
        offsets[i] = o;
        for (let k = 0; k < key.length; k++) text[o++] = key.charCodeAt(k);
      }
      offsets[n] = o;
      const edges = api.airwire_run();
      if (edges < 0) return refuse();
      const pairs = u32(api.out_u32(0), 2 * edges), lengths = f64(api.out_f64(0), edges), counts = u32(api.out_u32(1), nets.length);
      const out = [];
      for (let k = 0, e = 0; k < nets.length; k++) {
        const links = [], net = names[k];
        for (let end = e + counts[k]; e < end; e++) {
          const a = anchors[pairs[2 * e]], b = anchors[pairs[2 * e + 1]];
          links.push({net, from: a.at, to: b.at, fromId: a.id, toId: b.id, fromLabel: a.label, toLabel: b.label, distance: Math.sqrt(lengths[e])});
        }
        out.push(links);
      }
      return out;
    } catch (error) {
      return refuse(error);
    }
  }

  // The DRC broad phase (engine/src/pairs.rs): the pairs rules.js pairs() visits, in its order, as a
  // Uint32Array [a, b, a, b, ...] of feature indices, or null (the JS loop runs). boxes: [x0, y0,
  // x1, y1] per feature; size: the grid cell; reach: the largest gap.
  const MAX_PAIR_FEATURES = 8_000_000;
  function pairsCall(values, stride, params, run) {
    if (!api) return null;
    stats.calls++;
    try {
      if (!(values instanceof Float64Array) || values.length % stride || values.length / stride > MAX_PAIR_FEATURES) return refuse();
      const pV = api.in_f64(0, values.length), pP = api.in_f64(1, params.length);
      if (!pV || !pP) return refuse();
      f64(pV, values.length).set(values); f64(pP, params.length).set(params);
      const n = run();
      if (n < 0) return refuse();
      const out = u32(api.out_u32(0), 2 * n).slice();
      if (values.length > 1 << 20) api.engine_reset();
      return out;
    } catch (error) {
      return refuse(error);
    }
  }
  const gridPairs = (boxes, size, reach) => pairsCall(boxes, 4, [size, reach], () => api.pairs_grid());

  // One polygon pour task (polygon-pour.js PourCore().solve): the same {islands, stats} the JS
  // core returns, or null. Timings in stats: tSolve is the whole call; the per-phase ones are 0.
  function pourSolve(task) {
    if (!api) return null;
    stats.calls++;
    try {
      const started = typeof performance === "object" && performance.now ? performance.now() : Date.now();
      const {shapes, anchors} = task;
      const header = [task.K, task.hasBoard ? 1 : 0, task.removeDead ? 1 : 0, shapes.length, anchors.length];
      let values = 0;
      for (const s of shapes) {
        const ring = s.ring, tags = s.tags;
        if (!(ring instanceof Int32Array) || tags != null && !(tags instanceof Int32Array) || (s.sign !== 1 && s.sign !== -1) || !Number.isInteger(s.cls) || s.cls < 0) return refuse();
        header.push(s.cls, s.sign === 1 ? 0 : 1, ring.length, tags ? 1 : 0);
        values += ring.length + (tags ? tags.length : 0);
      }
      for (const a of anchors) { if (!(a instanceof Int32Array)) return refuse(); header.push(a.length); values += a.length; }
      if (values > MAX_POUR_VALUES || !Number.isInteger(task.K) || task.K < 0) return refuse();
      const pHeader = api.in_u32(0, header.length), pData = api.in_i32(0, values), pParams = api.in_f64(0, 2);
      if (!pHeader || !pData || !pParams) return refuse();
      u32(pHeader, header.length).set(header);
      const data = i32(pData, values);
      let o = 0;
      for (const s of shapes) {
        data.set(s.ring, o); o += s.ring.length;
        if (s.tags) { data.set(s.tags, o); o += s.tags.length; }
      }
      for (const a of anchors) { data.set(a, o); o += a.length; }
      f64(pParams, 2).set([+task.minArea, +task.minSize]);
      // Remove Necks / Outlines Only (task.morph): [mode, |t|, t, |u|, u, keep count, (|ring|, ring)...], or [0].
      const mo = task.morph, on = mo && (mo.mode === 1 || mo.mode === 2);
      let nm = 1;
      if (on) {
        const u = mo.u || EMPTY, keep = mo.keep || [];
        if (!(mo.t instanceof Int32Array) || !(u instanceof Int32Array) || !keep.every(r => r instanceof Int32Array)) return refuse();
        nm = 4 + mo.t.length + u.length; for (const r of keep) nm += 1 + r.length;
        if (nm > MAX_POUR_VALUES) return refuse();
      }
      const pMorph = api.in_i32(1, nm);
      if (!pMorph) return refuse();
      const mv = i32(pMorph, nm);
      if (!on) mv[0] = 0;
      else {
        const u = mo.u || EMPTY;let o = 0;
        mv[o++] = mo.mode; mv[o++] = mo.t.length; mv.set(mo.t, o); o += mo.t.length; mv[o++] = u.length; mv.set(u, o); o += u.length; mv[o++] = mo.keep.length;
        for (const r of mo.keep) { mv[o++] = r.length; mv.set(r, o); o += r.length; }
      }
      if (api.pour_solve() !== 0) return refuse();
      const out = i32(api.out_i32(0), api.out_i32_len(0)), st = u32(api.out_u32(0), 9);
      let at = 0;
      const ints = () => { const n = out[at++], r = out.slice(at, at + n); at += n; return r; };
      const ring = () => ({ring: ints(), tags: ints()});
      const islands = [];
      for (let n = out[at++]; n > 0; n--) {
        const r = ring(), links = Array.from(ints()), holes = [];
        for (let h = out[at++]; h > 0; h--) holes.push(ring());
        islands.push({ring: r.ring, tags: r.tags, links, holes});
      }
      // The keys the JS core sets, in its order (faces and rays only after a complete face walk).
      const result = {passes: st[0]};
      if (st[1]) result.unresolved = true;
      Object.assign(result, {edges: st[2], tPlanar: 0, merged: st[3], tMerge: 0});
      if (st[6]) result.faceFallback = true;
      if (st[4] !== 0xffffffff) Object.assign(result, {faces: st[4], rays: st[5]});
      result.tClassify = 0;
      if (st[7]) result.brokenRings = st[7];
      Object.assign(result, {tTrace: 0, tIslands: 0, deadIslands: st[8], tDead: 0});
      result.tSolve = (typeof performance === "object" && performance.now ? performance.now() : Date.now()) - started;
      return {islands, stats: result};
    } catch (error) {
      return refuse(error);
    }
  }

  const workerSource = () => api ? "globalThis.AtriumEngine=(" + createAtriumEngine.toString() + ")(" +
    JSON.stringify(kind) + "," + JSON.stringify(base64) + ");\n" : "";
  return Object.freeze({
    get available() { return !!api; },
    get failure() { return failure ? String(failure.message || failure) : null; },
    get variant() { return api ? kind : null; }, mode, ready, stats, airwires, pourSolve, gridPairs, workerSource
  });
}
