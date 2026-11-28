"use strict";
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("../pcb/pcb-appearance.js");
// Design Insights for boards (insights.js is the engine). Each check is advice with a short why,
// tuned for few false positives; a one-click fix is offered where the change is unambiguous
// (one undo step). DRC owns the hard limits: where an enabled rule already reports a case
// (Return Path, Current Capacity, HDI vias, Differential Pairs Routing), the insight stays quiet.
//
//   neck          poured copper narrowing between two wider areas, the only path between them
//                 (distance transform of each poured island, merge tree of its maxima; heavy)
//   returnPlane   high-speed tracks over a void or split in their reference plane, and layer
//                 changes without a stitching via or capacitor nearby (si.js, return-path.js; heavy)
//   acuteAngle    track corners and junctions below 90° (acid traps); fix: cut the corner
//   stub          a branch off a high-speed net between its pads (a stub)
//   widthCurrent  track width below or within 20 % of the IPC-2152 width for the net's current; fix: widen
//   thermalCurrent relief spokes too thin for the net's current; fix: connect those pads directly
//   viaInPad      a via inside an SMD pad without fill (IPC-4761 V–VII); fix: mark it filled and capped
//   decap         a power pin's nearest decoupling capacitor far away
//   diffPair      uncoupled length close to the limit, or long without one; P/N length skew
//   crosstalk     long parallel runs with a high near-end crosstalk estimate (si.js; heavy)
//   silk          board silkscreen over exposed pads
//   ringMin       annular ring at the rule minimum (no margin for drill wander); fix: enlarge the via
//   edgeCopper    copper just above the board-outline clearance minimum
//   deadCopper    poured islands that touch nothing of their pour's net (dead copper kept: Remove Dead
//                 Copper off), each with its location; fix: turn Remove Dead Copper on
//   pourFailed    a pour whose last refill failed (core error, worker hang, time budget): it kept
//                 its previous copper and is stale (polygon-pour.js failures)
globalThis.AtriumInsightsPCB = (() => {
  const G = globalThis, I = () => G.AtriumInsights;
  const I18N = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = I18N.define({
    "insights.neck.title": "Narrow neck in a pour",
    "insights.neck.message": "The {net} pour on {layer} narrows to {width} mm between two wider areas.",
    "insights.neck.current": " At {amps} A, IPC-2152 suggests at least {need} mm here.",
    "insights.neck.why": "All the current between the two areas, and the return current of the signals above them, has to squeeze through this neck: it has many times the resistance and inductance of the copper around it, heats first, and a thin bridge between wide copper is easily over-etched. Widen the gap the copper flows through, move what blocks it, or stitch both sides to another layer of the same net.",
    "insights.neck.pref_help": "Flag copper necks that may carry too little current.",
    "insights.neck.learn": "Planes and pours behave like wide, low-impedance conductors only where they are wide. A neck is found from the poured copper itself: the narrowest place on the widest path between two areas that are each much wider than the neck, when there is no other path between them. Parallel paths (a row of antipads, two bridges) are not reported. Threshold and sensitivity: Preferences › Design Insights.",
    "insights.return.title": "Return path interrupted",
    "insights.return.void": "{net} runs {length} mm over a gap in its {ref} reference.",
    "insights.return.partial": "{net} runs {length} mm along the edge of its {ref} reference, partly off the copper.",
    "insights.return.split": "{net} crosses a split in its reference on {ref} ({from} → {to}).",
    "insights.return.straddle": "{net} straddles a split between two nets on {ref}.",
    "insights.return.via": "{net} changes layer {from} → {to} with no {ref} stitching via within {distance} mm.",
    "insights.return.cap": "{net} changes layer {from} → {to}; its reference changes net ({nets}) with no stitching capacitor within {distance} mm.",
    "insights.return.why": "A fast signal's return current flows in the reference plane right under the track. A gap or split forces it around: the loop area grows, the impedance jumps, and the signal radiates and couples into its neighbours. At a layer change the return current changes planes too; a stitching via (same net) or a capacitor (different nets) next to the signal via gives it a short path.",
    "insights.return.pref_help": "Flag gaps in the signal return path.",
    "insights.return.learn": "Checked for high-speed nets: differential pairs, nets with an impedance profile or a high-speed net class, and names such as CLK, USB, DDR, HDMI, PCIe, ETH or MIPI (Preferences › Design Insights can include every signal net). The analysis is the board's own copper (Tools › Signal Integrity). Nets covered by a Return Path design rule are left to DRC.",
    "insights.return.fix_via": "Add a {net} stitching via",
    "insights.acute.title": "Acute copper angle",
    "insights.acute.corner": "This {layer} track turns through a {angle}° corner.",
    "insights.acute.junction": "Tracks of {net} meet at {angle}° on {layer}.",
    "insights.acute.why": "Etchant pools in the narrow wedge of an acute angle (an acid trap) and can eat into the copper; the sharp corner also concentrates current and field. Use corners of 90° or more, or 45° bends.",
    "insights.acute.pref_help": "Flag sharp angles between copper segments.",
    "insights.acute.learn": "Junctions and corners narrower than the threshold angle are reported; Tools › DFM Check checks the fab's limit. The fix replaces the corner with two obtuse bends.",
    "insights.acute.fix": "Cut the corner",
    "insights.stub.title": "Stub on a high-speed net",
    "insights.stub.message": "A {length} mm branch leaves {net} between its pads.",
    "insights.stub.why": "On a fast net every branch is a stub: the edge reflects from its open end and returns as ringing. Route through each pad in turn (daisy chain) or keep the branch much shorter than the rise time's length.",
    "insights.stub.pref_help": "Flag long branches with open ends.",
    "insights.stub.learn": "Reported for high-speed nets when a track joins the middle of another track of the same net away from any pad or via, and the branch is longer than the threshold.",
    "insights.width.title": "Track width for the current",
    "insights.width.below": "{net} is set to carry {amps} A; this {width} mm track is narrower than the {need} mm IPC-2152 suggests for a {rise} °C rise.",
    "insights.width.marginal": "{net} is set to carry {amps} A; this {width} mm track has only {margin} % margin over the {need} mm IPC-2152 width.",
    "insights.width.why": "Undersized copper heats, drops voltage and ages faster. A little margin covers etch tolerance, plating variation and neighbours that warm the track.",
    "insights.width.pref_help": "Compare track widths with expected current.",
    "insights.width.learn": "Currents come from Design › Rules › Net Currents (or Class Currents). Widths use IPC-2152 with this board's copper thickness. Nets covered by a Current Capacity rule are checked by DRC below the limit; the insight only adds the marginal case.",
    "insights.width.fix": "Widen to {width} mm",
    "insights.thermal.title": "Thermal relief starves the current",
    "insights.thermal.message": "{count} relief pads on {net} ({label}) have spokes for about {spokes} mm of copper; the net is set to carry {amps} A ({need} mm by IPC-2152).",
    "insights.thermal.why": "Relief spokes keep a pad easy to solder but are narrow conductors. A pin that carries the net's current through them heats and drops voltage at the joint.",
    "insights.thermal.pref_help": "Flag thermal spokes that may restrict current.",
    "insights.thermal.learn": "Spoke width and count come from the polygon connect style and its rules. Use a direct connection for high-current pins (as Auto does), more or wider spokes, or a pad override.",
    "insights.thermal.fix": "Connect these pads directly",
    "insights.vip.title": "Via in pad without fill",
    "insights.vip.message": "This via sits in pad {pad} and is not filled (IPC-4761 Type {type}).",
    "insights.vip.why": "An open via in an SMD pad wicks solder away from the joint and can leave voids under the part. Filled and capped vias (IPC-4761 Type VII) are flat and solderable; tell the fab with the via's fill type.",
    "insights.vip.pref_help": "Flag vias that can draw solder out of a pad.",
    "insights.vip.learn": "A via counts as in the pad when its centre is inside a footprint's SMD pad on the via's outer layer. HDI Vias rules with Require fill are reported by DRC instead.",
    "insights.vip.fix": "Mark filled and capped (Type VII)",
    "insights.decap.title": "Decoupling capacitor far from its pin",
    "insights.decap.message": "The nearest {net} decoupling capacitor ({cap}) is {distance} mm from {ref}-{pin}.",
    "insights.decap.why": "A decoupling capacitor works through the loop it forms with the pin: every millimetre of track and via adds inductance, so fast current pulses come from farther away and the supply rings. Put a small capacitor next to each power pin, with its own short via to ground.",
    "insights.decap.pref_help": "Flag capacitors too far from the power pin.",
    "insights.decap.learn": "For each power pin of an IC (U…, IC…), the capacitors (C…) between that net and a ground net are found and the nearest pad-to-pad distance compared with the threshold.",
    "insights.pair.title": "Differential pair coupling",
    "insights.pair.uncoupled": "{pair} runs {length} mm uncoupled ({max} mm allowed).",
    "insights.pair.uncoupled_free": "{pair} runs {length} mm uncoupled.",
    "insights.pair.skew": "{pair}: {p} and {n} differ by {skew} mm in length.",
    "insights.pair.why": "A differential pair rejects noise and keeps its impedance only while the two tracks stay together; uncoupled stretches and length skew turn part of the signal into common mode, which radiates.",
    "insights.pair.pref_help": "Flag pair spacing and length mismatch.",
    "insights.pair.learn": "From the Signal Integrity analysis of each pair (Design › Rules › Differential Pairs). Pairs over their Max Uncoupled Length are reported by DRC; this tip appears from 80 % of it.",
    "insights.xtalk.title": "Long parallel run (crosstalk)",
    "insights.xtalk.message": "{victim} runs {length} mm beside {aggressor} ({gap} mm gap, {relation}): about {pct} % near-end crosstalk.",
    "insights.xtalk.same": "same layer",
    "insights.xtalk.adjacent": "adjacent layers",
    "insights.xtalk.why": "Tracks side by side couple through their mutual capacitance and inductance; the longer the run and the smaller the gap, the more of one signal appears on the other. Increase the gap (3× the height to the plane is a common rule), shorten the run, or route on layers at right angles.",
    "insights.xtalk.pref_help": "Flag parallel tracks likely to couple.",
    "insights.xtalk.learn": "A screening estimate from the Signal Integrity crosstalk model (Tools › Signal Integrity), for high-speed nets only.",
    "insights.silk.title": "Silkscreen over a pad",
    "insights.silk.message": "Silkscreen crosses pad {pad}.",
    "insights.silk.why": "The fab clips silkscreen away from exposed copper, so the marking comes out broken, and ink left on a pad spoils the solder joint.",
    "insights.silk.pref_help": "Flag legend ink covering exposed pads.",
    "insights.silk.learn": "Board silkscreen lines and text over footprint and free pads on the same side. Tools › DFM Check checks footprints' own silkscreen against the fab's limits.",
    "insights.ring.title": "Annular ring at the minimum",
    "insights.ring.message": "{what} ring {ring} mm is at the {min} mm minimum: no margin for drill wander.",
    "insights.ring.why": "Drills wander and holes come out a little larger than drawn. With no margin above the minimum, a small error breaks the ring out of the pad and weakens the joint to the track.",
    "insights.ring.pref_help": "Flag rings close to the fabrication minimum.",
    "insights.ring.learn": "Compared with the Minimum Annular Ring rule. The fix enlarges the via land to the minimum plus the margin.",
    "insights.ring.fix": "Enlarge to {diameter} mm",
    "insights.ring.via": "Via",
    "insights.ring.pad": "Pad",
    "insights.dead.title": "Dead copper in a pour",
    "insights.dead.message": "An island of the {name} pour ({area} mm²) touches nothing on {net}.",
    "insights.dead.why": "Copper that connects to nothing of its net floats: it couples noise between the signals around it, can act as an antenna, and carries no current. Altium and most fabs expect it removed unless it is there on purpose (thieving, shielding stitched elsewhere).",
    "insights.dead.pref_help": "Flag copper left isolated after a pour.",
    "insights.dead.learn": "Reported for pours with a net whose Remove Dead Copper is off (Pours panel, or the pour's properties). Remove it there, stitch the island with a via, or keep it on purpose.",
    "insights.dead.fix": "Remove dead copper",
    "insights.pour.title": "Pour could not be refilled",
    "insights.pour.message": "The {name} pour kept its previous copper because {reason}. It stays stale until it repours.",
    "insights.pour.why": "The copper shown for this pour is from before the last edits, so it may not clear new objects or connect new pads. Fabrication outputs warn while a pour is stale.",
    "insights.pour.pref_help": "Flag pours that need attention before export.",
    "insights.pour.learn": "A refill fails when its solve stops responding, runs past its time budget (60 s) or meets an internal error; the other pours are refilled as usual. Simplify the outline or the objects in it, or raise its arc approximation, then use Repour All (it tries again).",
    "insights.edge.title": "Copper close to the board edge",
    "insights.edge.message": "Copper is {distance} mm from the board edge, {above} mm above the {min} mm minimum.",
    "insights.edge.why": "Board routing and V-scoring have a tolerance of a tenth of a millimetre or more; copper right at the clearance can be exposed or cracked when the board is separated.",
    "insights.edge.pref_help": "Flag copper near the fabrication edge clearance.",
    "insights.edge.learn": "Compared with the Board Outline Clearance rule plus the margin. Tools › DFM Check also checks V-scores and mouse bites of a panel."
  });
  const N = v => String(Math.round(v * 100) / 100);
  const N3 = v => String(Math.round(v * 1000) / 1000);
  const layerName = l => { try { return G.AtriumPCBAppearance?.name?.(l) || l; } catch { return l; } };
  const COPPER = /^(Top|Bottom|Inner \d+)$/;
  const SILK = /silk|overlay/i;

  // ---------------------------------------------------------------- necks
  // Necks of one poured island (rings: Float64Array [x0,y0,x1,y1,…], outer ring first, then holes;
  // even-odd). A generator: yields between phases, returns [{at, a, b, width, sides:[wa, wb]}] or
  // null when the island is too large to resolve at the threshold.
  function* necksOf(rings, T, o = {}) {
    const MAX = o.maxCells || 700000, ratio = o.ratio || 2.5, minSide = o.minSide || 2 * T, minArea = o.minArea || 2 * minSide * minSide, verify = o.verify ?? 12;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, E = 0;
    for (const r of rings) { for (let i = 0; i < r.length; i += 2) { const x = r[i], y = r[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } E += r.length >> 1; }
    const bw = x1 - x0, bh = y1 - y0;
    if (!(bw > 0 && bh > 0) || Math.min(bw, bh) < minSide) return [];
    const h = Math.max(T / 6, Math.sqrt(bw * bh / MAX));
    if (h > T / 2.5) return null;
    const W = Math.ceil(bw / h) + 3, H = Math.ceil(bh / h) + 3, ox = x0 - h, oy = y0 - h, C = W * H;
    // Edges, bucketed by the rows their y-extent touches (CSR), for the scanline fill and the nearest-edge search.
    const ex0 = new Float64Array(E), ey0 = new Float64Array(E), ex1 = new Float64Array(E), ey1 = new Float64Array(E);
    let e = 0;
    for (const r of rings) { const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) { ex0[e] = r[2 * j]; ey0[e] = r[2 * j + 1]; ex1[e] = r[2 * i]; ey1[e] = r[2 * i + 1]; e++; } }
    const rowOf = y => Math.min(H - 1, Math.max(0, Math.floor((y - oy) / h)));
    const start = new Int32Array(H + 1);
    for (let k = 0; k < E; k++) { const a = rowOf(Math.min(ey0[k], ey1[k])), b = rowOf(Math.max(ey0[k], ey1[k])); for (let r = a; r <= b; r++) start[r + 1]++; }
    for (let r = 0; r < H; r++) start[r + 1] += start[r];
    const fill = start.slice(0, H), list = new Int32Array(start[H]);
    for (let k = 0; k < E; k++) { const a = rowOf(Math.min(ey0[k], ey1[k])), b = rowOf(Math.max(ey0[k], ey1[k])); for (let r = a; r <= b; r++) list[fill[r]++] = k; }
    yield;
    // Scanline fill at cell centres (even-odd).
    const inside = new Uint8Array(C), xs = [];
    for (let r = 0; r < H; r++) {
      const yc = oy + (r + .5) * h;
      xs.length = 0;
      for (let q = start[r]; q < start[r + 1]; q++) {
        const k = list[q], ya = ey0[k], yb = ey1[k];
        if ((ya <= yc) !== (yb <= yc)) xs.push(ex0[k] + (yc - ya) / (yb - ya) * (ex1[k] - ex0[k]));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const c0 = Math.max(0, Math.ceil((xs[q] - ox) / h - .5)), c1 = Math.min(W - 1, Math.floor((xs[q + 1] - ox) / h - .5));
        for (let c = c0; c <= c1; c++) inside[r * W + c] = 1;
      }
      if ((r & 127) === 127) yield;
    }
    // Squared Euclidean distance (in cells) to the nearest outside cell centre (Felzenszwalb).
    const INF = 1e20, f = new Float64Array(C), n = Math.max(W, H), g = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let c = 0; c < C; c++) f[c] = inside[c] ? INF : 0;
    const edt = len => {
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + g[v[k]]; }
    };
    for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) g[y] = f[y * W + x]; edt(H); for (let y = 0; y < H; y++) f[y * W + x] = d[y]; if ((x & 255) === 255) yield; }
    for (let y = 0; y < H; y++) { const b = y * W; for (let x = 0; x < W; x++) g[x] = f[b + x]; edt(W); for (let x = 0; x < W; x++) f[b + x] = d[x]; if ((y & 255) === 255) yield; }
    // Cells in decreasing distance (counting sort on the integer squared distance).
    let maxF = 0, count = 0;
    for (let c = 0; c < C; c++) if (inside[c]) { count++; if (f[c] > maxF) maxF = f[c]; }
    if (!count) return [];
    let order;
    if (maxF < 4e6) {
      const bucket = new Int32Array(maxF + 2);
      for (let c = 0; c < C; c++) if (inside[c]) bucket[maxF - f[c] + 1]++;
      for (let k = 1; k < bucket.length; k++) bucket[k] += bucket[k - 1];
      order = new Int32Array(count);
      for (let c = 0; c < C; c++) if (inside[c]) order[bucket[maxF - f[c]]++] = c;
    } else {
      const cells = [];
      for (let c = 0; c < C; c++) if (inside[c]) cells.push(c);
      order = Int32Array.from(cells.sort((a, b) => f[b] - f[a]));
    }
    yield;
    // Merge tree of the distance maxima: a cell joining two components that are each wide (peak width and
    // area) at a level narrower than T is a neck candidate (the saddle of the widest path between them).
    const par = new Int32Array(C).fill(-1), size = new Int32Array(C), peak = new Int32Array(C);
    const find = c => { while (par[c] !== c) { par[c] = par[par[c]]; c = par[c]; } return c; };
    const widthAt = c => 2 * (Math.sqrt(f[c]) - .5) * h, cands = [], area = h * h;
    const NB = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
    for (let k = 0; k < count; k++) {
      const c = order[k];
      par[c] = c; size[c] = 1; peak[c] = c;
      const ws = widthAt(c);
      for (const dn of NB) {
        const m = c + dn;
        if (m < 0 || m >= C || par[m] === -1) continue;
        const ra = find(c), rb = find(m);
        if (ra === rb) continue;
        if (ws < T) {
          const wa = widthAt(peak[ra]), wb = widthAt(peak[rb]), need = Math.max(ratio * Math.max(ws, h), minSide);
          if (wa >= need && wb >= need && size[ra] * area >= minArea && size[rb] * area >= minArea) cands.push({c, pa: peak[ra], pb: peak[rb], w: ws, sides: [wa, wb]});
        }
        const [big, small] = size[ra] >= size[rb] ? [ra, rb] : [rb, ra];
        par[small] = big; size[big] += size[small];
        if (f[peak[small]] > f[peak[big]]) peak[big] = peak[small];
      }
      if ((k & 65535) === 65535) yield;
    }
    if (!cands.length) return [];
    cands.sort((a, b) => a.w - b.w);
    // Keep a candidate only when it is the sole connection: a flood from one side, with a disk around
    // the saddle removed, must not reach the other side through any copper.
    const seen = new Int32Array(C), queue = new Int32Array(C), out = [];
    let stamp = 0;
    for (const cd of cands.slice(0, verify)) {
      stamp++;
      const sx = cd.c % W, sy = (cd.c / W) | 0, rr = cd.w / 2 / h + 2.5, rr2 = rr * rr;
      const blocked = c => { const dx = c % W - sx, dy = ((c / W) | 0) - sy; return dx * dx + dy * dy <= rr2; };
      let head = 0, tail = 0, reached = false;
      if (blocked(cd.pa) || blocked(cd.pb)) continue;
      queue[tail++] = cd.pa; seen[cd.pa] = stamp;
      while (head < tail) {
        const c = queue[head++];
        if (c === cd.pb) { reached = true; break; }
        for (const dn of [-1, 1, -W, W]) {
          const m = c + dn;
          if (m < 0 || m >= C || !inside[m] || seen[m] === stamp || blocked(m)) continue;
          seen[m] = stamp; queue[tail++] = m;
        }
        if ((head & 262143) === 262143) yield;
      }
      if (reached) continue;
      // A neck that is a long channel of even width is marked in its middle: walk the ridge of the distance
      // field both ways from the saddle while the width stays within 10 %, and take the middle of the walk.
      let mc = cd.c;
      {
        stamp++;
        const lo = f[cd.c] * .81 - 1e-9, hi = f[cd.c] * 1.21 + 1e-9;
        seen[cd.c] = stamp;
        const walk = () => {
          const path = [];
          let c = cd.c;
          for (let k = 0; k < 20000; k++) {
            let best = -1;
            for (const dn of [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1]) {
              const m = c + dn;
              if (m < 0 || m >= C || !inside[m] || seen[m] === stamp || f[m] < lo || f[m] > hi) continue;
              if (best < 0 || f[m] > f[best]) best = m;
            }
            if (best < 0) break;
            // Mark the step's neighbourhood so the walk goes on along the channel, not back or sideways.
            for (const dn of [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1]) { const m = c + dn; if (m >= 0 && m < C) seen[m] = stamp; }
            path.push(best); c = best;
          }
          return path;
        };
        const a = walk(), b = walk(), line = [...a.reverse(), cd.c, ...b];
        mc = line[(line.length / 2) | 0];
      }
      const mx = mc % W, my = (mc / W) | 0;
      // The neck across: the nearest edge point, and the nearest one on the opposite side.
      const s = [ox + (mx + .5) * h, oy + (my + .5) * h], R = Math.ceil((cd.w / 2 + 3 * h) / h) + 1;
      let p1 = null, d1 = Infinity;
      const near = (visit) => { const r0 = Math.max(0, my - R), r1 = Math.min(H - 1, my + R); for (let r = r0; r <= r1; r++) for (let q = start[r]; q < start[r + 1]; q++) visit(list[q]); };
      const foot = k => { const a = [ex0[k], ey0[k]], b = [ex1[k], ey1[k]]; const r = I().geometry.segDist(s, a, b); return r; };
      near(k => { const r = foot(k); if (r.d < d1) { d1 = r.d; p1 = r.at; } });
      if (!p1) continue;
      let p2 = null, d2 = Infinity;
      const ux = p1[0] - s[0], uy = p1[1] - s[1], ul = Math.hypot(ux, uy) || 1;
      near(k => {
        const r = foot(k), vx = r.at[0] - s[0], vy = r.at[1] - s[1], vl = Math.hypot(vx, vy) || 1;
        if ((ux * vx + uy * vy) / (ul * vl) < -.5 && r.d < d2) { d2 = r.d; p2 = r.at; }
      });
      const width = p2 ? Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) : 2 * d1;
      if (!(width < T)) continue;
      const at = p2 ? [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] : s;
      if (out.some(x => Math.hypot(x.at[0] - at[0], x.at[1] - at[1]) < 1.5 * T)) continue;
      out.push({at, a: p1, b: p2 || [2 * s[0] - p1[0], 2 * s[1] - p1[1]], width, sides: cd.sides});
    }
    return out;
  }
  // Every neck of the board's poured copper, memoised per region (a repour replaces the region).
  function* neckCheck(ctx) {
    const P = G.AtriumPCBPours, regions = ctx.doc.pcbDrawing?.pours || [], s = ctx.settings, out = [];
    if (!regions.length) return out;
    if (!P?.contours) { ctx.notes.push("Poured copper was not checked for necks (the pour module is not loaded)."); return out; }
    const key = "neck|" + s.width + "|" + s.ratio;
    let skipped = 0;
    for (const reg of regions) {
      const poly = reg.polygon != null ? ctx.byId.get(reg.polygon) : null;
      if (poly && (poly.fillMode === "hatch" || poly.fillMode === "outline" || poly.cutout || poly.shelved)) continue;
      const net = poly?.net || reg.net || "";
      let memo = ctx.memo.get(reg);
      if (!memo || memo.key !== key) {
        let rings;
        try { rings = P.contours(reg); } catch { rings = null; }
        const necks = rings?.length ? yield* necksOf(rings, s.width, {ratio: s.ratio}) : [];
        memo = {key, necks};
        ctx.memo.set(reg, memo);
        yield;
      }
      if (memo.necks == null) { skipped++; continue; }
      const p0 = poly?.points?.[0] || [0, 0], layer = poly?.layer || reg.layer || "";
      // A pour with Remove Necks already cut every neck narrower than its width (it only has wider ones).
      const cut = poly?.fillMode !== "hatched" && +poly?.neckWidth > 0 ? +poly.neckWidth : 0;
      for (const x of memo.necks) {
        if (x.width < cut) continue;
        const amps = ctx.currentOf(net), need = amps > 0 ? ctx.ipcWidth(amps, layer) : 0;
        const message = t("insights.neck.message", {net: net || "copper", layer: layerName(layer), width: N(x.width)}) + (amps > 0 && need > x.width ? t("insights.neck.current", {amps: N(amps), need: N(need)}) : "");
        out.push({objects: [poly?.id || "pour:" + layer + ":" + net], at: x.at, line: [x.a, x.b], net, layer, value: I().geometry.dist(x.a, x.b),
          severity: ctx.isPower(net) || ctx.isGround(net) || amps > 0 ? "advice" : "tip", message,
          sig: [layer, net, Math.round((x.at[0] - p0[0]) / 2), Math.round((x.at[1] - p0[1]) / 2), Math.round(x.width * 10)].join("|")});
      }
    }
    if (skipped) ctx.notes.push(skipped + " poured island" + (skipped === 1 ? " is" : "s are") + " too large to check for necks at " + s.width + " mm.");
    return out;
  }

  // ---------------------------------------------------------------- return path (si.js)
  function siContext(ctx) {
    if (ctx._si !== undefined) return ctx._si;
    const SI = G.AtriumSI, s = ctx.settings;
    ctx._si = null;
    if (!SI?.context) { ctx.notes.push("Return paths were not checked (the signal integrity module is not loaded)."); return null; }
    try { ctx._si = SI.context(ctx.doc, ctx.defs, {project: ctx.project, returnRadius: s.viaDistance ?? 2, capRadius: s.capDistance ?? 5, minVoid: s.minVoid ?? .3}); }
    catch (e) { ctx.notes.push("Return paths: " + e.message); }
    return ctx._si;
  }
  function siNet(ctx, net) {
    const si = siContext(ctx);
    if (!si) return null;
    ctx._siNets ??= new Map();
    if (!ctx._siNets.has(net)) { let r = null; try { r = G.AtriumSI.analyzeNet(si, net); } catch (e) { ctx.notes.push(net + ": " + e.message); } ctx._siNets.set(net, r); }
    return ctx._siNets.get(net);
  }
  // The reports and plane indexes are working data shared by this pass's SI checks.
  // Published findings and their fixes need only the completed output.
  function releaseSI(ctx) {
    delete ctx._siNets;
    delete ctx._si;
  }
  const trackNets = (ctx, nets) => {
    const out = [];
    for (const net of nets ? [...nets] : ctx.netNames()) if (ctx.netItemsOf(net).some(i => i.kind === "track")) out.push(net);
    return out.sort();
  };
  function* returnCheck(ctx, scope) {
    const s = ctx.settings, out = [];
    const nets = trackNets(ctx, scope?.nets).filter(n => ctx.highSpeed(n) && !ctx.ruleCovers("returnPath", {net: n}));
    if (!nets.length || !siContext(ctx)) return out;
    const RP = G.AtriumReturnPath;
    for (const net of nets) {
      const r = siNet(ctx, net);
      yield;
      if (!r) continue;
      // Pieces of one gap along one track merge into one insight (the longest piece marks it).
      const groups = new Map();
      for (const e of r.events) {
        if (e.kind === "no-reference") continue;
        const k = [e.kind === "partial" ? "partial" : e.kind, e.id, e.ref, e.from || "", e.to || ""].join("|");
        let g = groups.get(k);
        if (!g) groups.set(k, g = {e, length: 0, best: e});
        g.length += e.length || 0;
        if ((e.length || 0) > (g.best.length || 0)) g.best = e;
      }
      // The gap of a split is the split itself: a short void next to a crossing of the same track is not reported twice.
      const crossings = [...groups.values()].filter(g => g.e.kind === "split-crossing");
      for (const g of groups.values()) {
        const e = g.best, kind = e.kind, length = g.length;
        if ((kind === "void" || kind === "partial") && crossings.some(c => c.e.id === e.id && c.e.ref === e.ref && I().geometry.dist(c.e.at, e.at) <= length / 2 + 1)) continue;
        if ((kind === "void") && length < s.minVoid) continue;
        if (kind === "partial" && length < s.minPartial) continue;
        const message = kind === "void" ? t("insights.return.void", {net, length: N(length), ref: layerName(e.ref)})
          : kind === "partial" ? t("insights.return.partial", {net, length: N(length), ref: layerName(e.ref)})
          : kind === "split-crossing" ? t("insights.return.split", {net, ref: layerName(e.ref), from: e.from, to: e.to})
          : t("insights.return.straddle", {net, ref: layerName(e.ref)});
        out.push({objects: [e.id], at: e.at, line: e.a && e.b && (e.a[0] !== e.b[0] || e.a[1] !== e.b[1]) ? [e.a, e.b] : null, net, layer: e.layer, value: length || null,
          severity: kind === "partial" ? "tip" : "advice", message, sig: [kind, e.ref, e.from || "", e.to || "", kind === "void" || kind === "partial" ? Math.round(length) : ""].join("|")});
      }
      for (const x of r.returns || []) {
        if (x.status === "ok" || (x.kind !== "missing-via" && x.kind !== "net-change")) continue;
        const refs = [...new Set([...(x.refsFrom || []), ...(x.refsTo || [])].map(q => q.net).filter(Boolean))];
        let fix = null;
        if (x.kind === "missing-via" && RP?.suggest) {
          let sug = null;
          try { sug = RP.suggest(siContext(ctx), x, {distance: s.viaDistance, outline: ctx.doc.outline}); } catch { sug = null; }
          if (sug) fix = {label: t("insights.return.fix_via", {net: sug.net}), preview: {kind: "via", at: sug.at, diameter: sug.diameter},
            apply(doc) { const v = RP.apply(doc, sug, {drill: G.AtriumPref?.get?.("pcb.viaDrill", .3) ?? .3}); return [v.id]; }};
        }
        const message = x.kind === "missing-via" ? t("insights.return.via", {net, from: layerName(x.from), to: layerName(x.to), ref: refs[0] || "reference", distance: N(s.viaDistance)})
          : t("insights.return.cap", {net, from: layerName(x.from), to: layerName(x.to), nets: refs.join(" / "), distance: N(s.capDistance)});
        out.push({objects: [x.via], at: x.at, net, severity: "advice", message, fix, sig: [x.kind, x.from, x.to, refs.join("/")].join("|")});
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- acute angles
  const tracksIn = (ctx, boxes) => ctx.itemsIn(boxes).filter(i => i.kind === "track" && Array.isArray(i.points) && i.points.length > 1 && COPPER.test(i.layer || "Top") && !i.keepout);
  const angleAt = (p, a, b) => {
    const ux = a[0] - p[0], uy = a[1] - p[1], vx = b[0] - p[0], vy = b[1] - p[1], lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!(lu > 1e-6 && lv > 1e-6)) return 180;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) * 180 / Math.PI;
  };
  function acuteCheck(ctx, scope) {
    const s = ctx.settings, out = [], limit = s.angle, tracks = tracksIn(ctx, scope?.boxes);
    for (const tr of tracks) {
      const P = tr.points;
      for (let k = 1; k + 1 < P.length; k++) {
        const ang = angleAt(P[k], P[k - 1], P[k + 1]);
        if (!(ang + 1e-6 < limit) || ang < 1) continue;
        const id = tr.id, at = P[k].slice(), idx = k;
        out.push({objects: [id], at, net: tr.net || null, layer: tr.layer, value: Math.round(ang), message: t("insights.acute.corner", {layer: layerName(tr.layer || "Top"), angle: Math.round(ang)}),
          sig: ["corner", idx, Math.round(ang / 5), tr.layer].join("|"),
          fix: {label: t("insights.acute.fix"), apply(doc) {
            const it = doc.items.find(i => i.id === id), pts = it?.points;
            if (!pts || !pts[idx] || Math.hypot(pts[idx][0] - at[0], pts[idx][1] - at[1]) > 1e-6) throw Error("The track changed; check the board again.");
            const p = pts[idx], a = pts[idx - 1], b = pts[idx + 1], la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
            const c = Math.min(.4 * la, .4 * lb, Math.max(2 * (+it.width || .2), .5));
            const q1 = [p[0] + (a[0] - p[0]) / la * c, p[1] + (a[1] - p[1]) / la * c], q2 = [p[0] + (b[0] - p[0]) / lb * c, p[1] + (b[1] - p[1]) / lb * c];
            pts.splice(idx, 1, q1.map(v => Math.round(v * 1e4) / 1e4), q2.map(v => Math.round(v * 1e4) / 1e4));
            return [id];
          }}});
      }
    }
    // Junctions: track ends of one net and layer that meet another track (end or middle).
    const all = scope?.boxes ? tracksIn(ctx, scope.boxes.map(b => ctx.grow(b, 2))) : tracks, g = ctx.grid(2);
    for (const tr of all) for (let k = 1; k < tr.points.length; k++) { const a = tr.points[k - 1], b = tr.points[k]; g.insert([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], {tr, k}); }
    const done = new Set();
    for (const tr of tracks) for (const end of [0, tr.points.length - 1]) {
      const p = tr.points[end], key = Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000) + "|" + tr.layer;
      if (done.has(key)) continue;
      done.add(key);
      const arms = [], ids = new Set(), eps = 1e-3;
      g.query([p[0] - eps, p[1] - eps, p[0] + eps, p[1] + eps], ({tr: o, k}) => {
        if (o.layer !== tr.layer || (o.net || "") !== (tr.net || "")) return;
        const a = o.points[k - 1], b = o.points[k], r = ctx.segDist(p, a, b);
        if (r.d > eps) return;
        ids.add(o.id);
        if (Math.hypot(a[0] - p[0], a[1] - p[1]) > eps) arms.push({d: Math.atan2(a[1] - p[1], a[0] - p[0]), id: o.id});
        if (Math.hypot(b[0] - p[0], b[1] - p[1]) > eps) arms.push({d: Math.atan2(b[1] - p[1], b[0] - p[0]), id: o.id});
      });
      if (ids.size < 2 || arms.length < 2) continue;
      arms.sort((a, b) => a.d - b.d);
      let worst = 360, pair = null;
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i], b = arms[(i + 1) % arms.length];
        let gap = (b.d - a.d) * 180 / Math.PI; if (i === arms.length - 1) gap += 360;
        if (a.id === b.id) continue; // one track's own corner (reported above)
        if (gap < worst) { worst = gap; pair = [a.id, b.id]; }
      }
      if (!pair || !(worst + 1e-6 < s.angle) || worst < 1) continue;
      out.push({objects: [...new Set(pair)].sort(), at: p.slice(), net: tr.net || null, layer: tr.layer, value: Math.round(worst),
        message: t("insights.acute.junction", {net: tr.net || "(no net)", angle: Math.round(worst), layer: layerName(tr.layer)}), sig: ["junction", Math.round(worst / 5), tr.layer].join("|")});
    }
    return out;
  }

  // ---------------------------------------------------------------- stubs on high-speed nets
  function stubCheck(ctx, scope) {
    const s = ctx.settings, out = [];
    for (const net of trackNets(ctx, scope?.nets)) {
      if (!ctx.highSpeed(net)) continue;
      const tracks = ctx.netItemsOf(net).filter(i => i.kind === "track" && Array.isArray(i.points) && i.points.length > 1);
      if (tracks.length < 2) continue;
      const stops = ctx.netItemsOf(net).filter(i => i.kind === "via" || i.kind === "pad").map(i => [i.x, i.y]);
      for (const p of ctx.netPads(net)) stops.push(p.at);
      const atStop = q => stops.some(x => Math.hypot(x[0] - q[0], x[1] - q[1]) < .05);
      const len = tr => tr.points.reduce((L, p, k) => k ? L + Math.hypot(p[0] - tr.points[k - 1][0], p[1] - tr.points[k - 1][1]) : 0, 0);
      for (const b of tracks) for (const end of [0, b.points.length - 1]) {
        const q = b.points[end];
        if (atStop(q)) continue;
        // q on the interior of another track's segment (a T), not at its ends.
        const host = tracks.find(a => a !== b && a.layer === b.layer && a.points.some((p, k) => k && (() => { const r = ctx.segDist(q, a.points[k - 1], p); return r.d < .01 && r.t > .001 && r.t < .999; })()));
        if (!host) continue;
        const L = len(b);
        if (L < s.length) continue;
        out.push({objects: [b.id, host.id], at: q.slice(), net, layer: b.layer, value: L, message: t("insights.stub.message", {length: N(L), net}), sig: ["stub", Math.round(L)].join("|")});
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- currents
  function widthCheck(ctx, scope) {
    const s = ctx.settings, out = [];
    for (const net of trackNets(ctx, scope?.nets)) {
      const amps = ctx.currentOf(net);
      if (!(amps > 0)) continue;
      const covered = ctx.ruleCovers("currentCapacity", {net});
      for (const tr of ctx.netItemsOf(net)) {
        if (tr.kind !== "track" || !COPPER.test(tr.layer || "Top") || !(tr.width > 0)) continue;
        const need = ctx.ipcWidth(amps, tr.layer || "Top", s.rise), w = +tr.width;
        if (!(need > 0)) continue;
        const below = w + 1e-6 < need, marginal = !below && w < need * (1 + s.margin / 100);
        if (!(below && !covered) && !marginal) continue;
        const to = Math.ceil(need * (1 + s.margin / 100 + .05) / .05) * .05, id = tr.id, p = tr.points, mid = p[(p.length / 2) | 0];
        out.push({objects: [id], at: p.length === 2 ? [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2] : mid.slice(), net, layer: tr.layer, value: w, severity: below ? "advice" : "tip",
          message: below ? t("insights.width.below", {net, amps: N(amps), width: N3(w), need: N3(need), rise: N(s.rise)}) : t("insights.width.marginal", {net, amps: N(amps), width: N3(w), margin: Math.round((w / need - 1) * 100), need: N3(need)}),
          sig: [below ? "below" : "marginal", N3(w), N(amps)].join("|"),
          fix: {label: t("insights.width.fix", {width: N3(to)}), apply(doc) { const it = doc.items.find(i => i.id === id); if (!it) throw Error("The track is gone."); it.width = Math.round(to * 1e4) / 1e4; return [id]; }}});
      }
    }
    return out;
  }
  function thermalCheck(ctx, scope) {
    const PP = G.AtriumPolygonPour, out = [];
    if (!PP?.connections) return out;
    for (const poly of scope?.nets ? [...scope.nets].flatMap(n => ctx.netItemsOf(n)) : ctx.doc.items) {
      if (poly.kind !== "polygon" || !poly.net || poly.cutout || poly.keepout || (scope?.nets && !scope.nets.has(poly.net))) continue;
      const amps = ctx.currentOf(poly.net);
      if (!(amps > 0)) continue;
      let ds = [];
      try { ds = PP.connections(ctx.doc, ctx.defs, poly, {connect: ctx.connect, project: ctx.project}); } catch { ds = []; }
      const weak = [];
      for (const d of ds) {
        if (d.style !== "relief" || !(d.spokeWidth > 0)) continue;
        const total = d.spokeWidth * (d.entries || 4), need = ctx.ipcWidth(amps, d.layer || poly.layer, 10);
        if (total + 1e-6 < need) weak.push({d, total, need});
      }
      if (!weak.length) continue;
      weak.sort((a, b) => a.total - b.total);
      const w = weak[0], id = poly.id, keys = weak.map(x => x.d.key);
      out.push({objects: [id], at: w.d.at || [poly.points[0][0], poly.points[0][1]], net: poly.net, layer: poly.layer, value: w.total, severity: "advice",
        message: t("insights.thermal.message", {count: weak.length, net: poly.net, label: weak.slice(0, 3).map(x => x.d.label).join(", ") + (weak.length > 3 ? " …" : ""), spokes: N(w.total), amps: N(amps), need: N(w.need)}),
        sig: ["thermal", weak.length, N(w.total), N(amps)].join("|"),
        fix: {label: t("insights.thermal.fix"), apply(doc) {
          const it = doc.items.find(i => i.id === id); if (!it) throw Error("The polygon is gone.");
          it.connectOverrides = {...(it.connectOverrides && typeof it.connectOverrides === "object" ? it.connectOverrides : {}), ...Object.fromEntries(keys.map(k => [k, "direct"]))};
          return [id];
        }}});
    }
    return out;
  }

  // ---------------------------------------------------------------- vias in pads
  const padContains = (p, q, grow = 0) => AtriumResolvedLand.distance(p.land, q, p.at, p.angle, p.mirror) <= grow;
  const FILLED = new Set(["V", "VI", "VII"]);
  function vipCheck(ctx, scope) {
    const out = [];
    const pg = ctx.padGridIn(scope?.boxes || null);
    for (const v of ctx.itemsIn(scope?.boxes || null)) {
      if (v.kind !== "via" || !Number.isFinite(v.x) || (scope?.boxes && !scope.boxes.some(b => ctx.inBox([v.x, v.y], b)))) continue;
      if (FILLED.has(v.ipc4761) || ctx.ruleCovers("hdiVias", {net: v.net || ""})) continue;
      const at = [v.x, v.y], from = v.fromLayer || "Top", to = v.toLayer || "Bottom";
      let hit = null;
      pg.query([v.x - .01, v.y - .01, v.x + .01, v.y + .01], p => {
        if (hit || p.land.drill > 0 || !p.part || (p.layer !== from && p.layer !== to)) return;
        if (padContains(p, at)) hit = p;
      });
      if (!hit) continue;
      const id = v.id, label = (hit.part.ref || "") + "-" + hit.number;
      out.push({objects: [id, hit.part.id], at, land: (+v.diameter || .6) / 2, net: v.net || null, severity: "advice", message: t("insights.vip.message", {pad: label, type: v.ipc4761 && v.ipc4761 !== "none" ? v.ipc4761 : "none"}),
        sig: ["vip", hit.number, v.ipc4761 || "none"].join("|"),
        fix: {label: t("insights.vip.fix"), apply(doc) { const it = doc.items.find(i => i.id === id); if (!it) throw Error("The via is gone."); it.ipc4761 = "VII"; it.viaInPad = true; return [id]; }}});
    }
    return out;
  }

  // ---------------------------------------------------------------- decoupling
  function decapCheck(ctx) {
    const s = ctx.settings, out = [], byPart = new Map();
    for (const p of ctx.pads) if (p.part) { if (!byPart.has(p.part)) byPart.set(p.part, []); byPart.get(p.part).push(p); }
    // Capacitors between a supply and ground: supply net → [{part, pad}].
    const caps = new Map();
    for (const [part, pads] of byPart) {
      if (!/^C\d/i.test(part.ref || "") || pads.length !== 2) continue;
      const [a, b] = pads;
      for (const [x, y] of [[a, b], [b, a]]) if (ctx.isPower(x.net) && ctx.isGround(y.net)) { if (!caps.has(x.net)) caps.set(x.net, []); caps.get(x.net).push({part, pad: x}); }
    }
    for (const [part, pads] of byPart) {
      if (!/^(U|IC)\d/i.test(part.ref || "") || pads.length < 3) continue;
      const nets = new Map();
      for (const p of pads) if (ctx.isPower(p.net) && caps.has(p.net)) { if (!nets.has(p.net)) nets.set(p.net, []); nets.get(p.net).push(p); }
      for (const [net, pins] of nets) {
        let worst = null;
        for (const pin of pins) {
          let best = null;
          for (const c of caps.get(net)) { const d = ctx.dist(pin.at, c.pad.at); if (!best || d < best.d) best = {d, c}; }
          if (best && (!worst || best.d > worst.d)) worst = {...best, pin};
        }
        if (!worst || worst.d <= s.distance) continue;
        out.push({objects: [part.id, worst.c.part.id], at: worst.pin.at.slice(), net, value: worst.d, line: [worst.pin.at, worst.c.pad.at],
          message: t("insights.decap.message", {net, cap: worst.c.part.ref, distance: N(worst.d), ref: part.ref, pin: worst.pin.number}), sig: ["decap", worst.pin.number, Math.round(worst.d / 2)].join("|")});
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- differential pairs and crosstalk (si.js)
  const nearestSeg = (ctx, net, at) => {
    let best = null;
    for (const i of ctx.netItemsOf(net)) if (i.kind === "track") for (let k = 1; k < i.points.length; k++) { const d = ctx.segDist(at, i.points[k - 1], i.points[k]).d; if (!best || d < best.d) best = {d, id: i.id}; }
    return best?.id || null;
  };
  function* pairCheck(ctx, scope) {
    const s = ctx.settings, out = [];
    for (const p of ctx.pairs) {
      if (!p.positive || !p.negative || (scope?.nets && !scope.nets.has(p.positive) && !scope.nets.has(p.negative))) continue;
      if (!ctx.netItemsOf(p.positive).some(i => i.kind === "track")) continue;
      const r = siNet(ctx, p.positive);
      yield;
      const d = r?.diff;
      if (!d) continue;
      const max = d.maxUncoupled, unc = d.uncoupled;
      if (max != null ? unc > max * s.near && unc <= max + 1e-6 : unc > s.uncoupled) {
        const run = [...d.runs].sort((a, b) => b.length - a.length)[0], at = run ? run.points[(run.points.length / 2) | 0] : null;
        if (at) out.push({objects: ["pair:" + p.name, nearestSeg(ctx, run.role === "P" ? p.positive : p.negative, at)].filter(Boolean), at, net: p.positive, value: unc,
          line: run.points.length > 1 ? [run.points[0], run.points[run.points.length - 1]] : null,
          message: max != null ? t("insights.pair.uncoupled", {pair: p.name, length: N(unc), max: N(max)}) : t("insights.pair.uncoupled_free", {pair: p.name, length: N(unc)}), sig: ["unc", Math.round(unc)].join("|")});
      }
      if (d.skew > s.skew && !ctx.ruleCovers("matchedLengths", {net: p.positive})) {
        const seg = ctx.netItemsOf(p.positive).find(i => i.kind === "track");
        if (seg) out.push({objects: ["pair:" + p.name, seg.id], at: seg.points[0].slice(), net: p.negative, value: d.skew, message: t("insights.pair.skew", {pair: p.name, p: N(d.lengthP), n: N(d.lengthN), skew: N(d.skew)}), sig: ["skew", Math.round(d.skew)].join("|")});
      }
    }
    return out;
  }
  function* xtalkCheck(ctx, scope) {
    const s = ctx.settings, out = [], seen = new Set();
    const nets = trackNets(ctx, scope?.nets).filter(n => ctx.highSpeed(n));
    if (!nets.length || !siContext(ctx)) return out;
    for (const net of nets) {
      const r = siNet(ctx, net);
      yield;
      for (const x of r?.crosstalk || []) {
        if (!(x.nextPct >= s.next) || ctx.pairNets.has(x.aggressor) && G.AtriumRules && ctx.pairs.some(p => (p.positive === net && p.negative === x.aggressor) || (p.negative === net && p.positive === x.aggressor))) continue;
        if (x.length < s.length) continue;
        const k = [net, x.aggressor].sort().join("\u0001");
        if (seen.has(k)) continue;
        seen.add(k);
        const st = [...x.stretches].sort((a, b) => b.kb - a.kb)[0], at = st ? [(st.a[0] + st.b[0]) / 2, (st.a[1] + st.b[1]) / 2] : null;
        if (!at) continue;
        out.push({objects: [nearestSeg(ctx, net, at), nearestSeg(ctx, x.aggressor, at)].filter(Boolean), at, net, netPair: [net, x.aggressor], value: x.nextPct, line: st ? [st.a, st.b] : null,
          message: t("insights.xtalk.message", {victim: net, aggressor: x.aggressor, length: N(x.length), gap: N(x.minGap), relation: t(x.relation === "adjacent" ? "insights.xtalk.adjacent" : "insights.xtalk.same"), pct: N(x.nextPct)}),
          sig: ["xt", [net, x.aggressor].sort().join("/"), x.relation, Math.round(x.nextPct)].join("|")});
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- silkscreen, rings, board edge
  function silkCheck(ctx, scope) {
    const out = [];
    const pg = ctx.padGridIn(scope?.boxes ? scope.boxes.map(b => ctx.grow(b, 3)) : null);
    for (const i of ctx.itemsIn(scope?.boxes || null)) {
      if (!(i.kind === "graphic" || i.kind === "label") || !SILK.test(i.layer || "")) continue;
      const box = ctx.boxOf(i);
      if (!box || (scope?.boxes && !scope.boxes.some(b => ctx.overlaps(box, b)))) continue;
      const face = /bottom/i.test(i.layer) ? "Bottom" : "Top", w = (+i.width || .15) / 2;
      const points = i.kind === "graphic" && Array.isArray(i.points) ? i.points : null;
      let hit = null;
      pg.query(points ? ctx.grow(box,w) : box, p => {
        if (hit || (p.layer !== "Multi" && p.layer !== face)) return;
        if (points) {
          const edges = points.length + (i.closed && points.length > 2 ? 1 : 0);
          for (let k = 1; k < edges && !hit; k++) {
            const a = points[k - 1], b = points[k % points.length];
            // Retain the anchor projection as the marker when it is a valid witness.
            const {at} = ctx.segDist(p.at,a,b);
            const contact = padContains(p,at,w) ? at : AtriumLandContours.strokeContact(p,a,b,w);
            if (contact) hit = {p,at:contact};
          }
        } else if (padContains(p, [Math.max(box[0], Math.min(box[2], p.at[0])), Math.max(box[1], Math.min(box[3], p.at[1]))])) hit = {p, at: p.at};
      });
      if (!hit) continue;
      const label = hit.p.part ? (hit.p.part.ref || "") + "-" + hit.p.number : "#" + (hit.p.number || "");
      out.push({objects: [i.id, hit.p.id], at: hit.at.slice(), layer: i.layer, message: t("insights.silk.message", {pad: label}), sig: ["silk", hit.p.number, i.layer].join("|")});
    }
    return out;
  }
  function ringAreaInput(ctx, dirty, kinds) {
    const rules = ctx.compiledRules;
    // A rule can disappear from the compiled set when an anchor goes missing,
    // or return when a previously ambiguous reference becomes unique.
    const stamp = rules?.diagnostics.filter(d => d.type === "annularRing").map(d => d.ruleId).join("|") ?? null;
    if (!dirty?.size || !rules) return {stamp, changed: false};
    // A scope can read another item, for example a component used as the anchor of a distance query.
    const itemPrefix = "item:" + ctx.doc.id + "/";
    const changed = rules.byType.annularRing.some(r =>
      r.scopePlan.dependencies.some(dep => dep.startsWith(itemPrefix) && dirty.has(dep.slice(itemPrefix.length)) ||
        dep === "field:length" || kinds.has("part") && ["relation:componentclass", "relation:xsignal", "relation:xsignalclass", "relation:signal", "relation:tag"].includes(dep)) ||
      r.scopePlan.references?.some(ref => ref.target?.itemId && dirty.has(ref.target.itemId)));
    return {stamp, changed};
  }
  function ringCheck(ctx, scope) {
    const rules = ctx.compiledRules, kit = G.AtriumRules?.kit, out = [];
    if (!rules?.byType.annularRing.length || !kit) return out;
    const boxes = scope?.boxes, margin = ctx.settings.margin;
    // Only the edited neighborhood is measured on an area pass. The rule is
    // compiled against the whole board, with the same hole subjects as DRC.
    const items = ctx.itemsIn(boxes || null).filter(i => i.kind === "part" || i.kind === "pad" && i.drill > 0 && i.plated !== false ||
      i.kind === "via" && i.drill > 0 && !i.padStack && !i.stackMode);
    const {holes} = kit.extract(ctx.doc, ctx.defs, {items, holesOnly: true});
    const platedHoles = new Map();
    for (const hole of holes) if (hole.parent && hole.plated) platedHoles.set(hole.id, (platedHoles.get(hole.id) || 0) + 1);
    for (const hole of holes) {
      const {id, at, drill, net, item, parent, padIndex, padCount} = hole;
      if (!at.every(Number.isFinite) || boxes && !boxes.some(b => ctx.inBox(at, b))) continue;
      const via = hole.kind === "via";
      // The advisory measures the authored land, including for stacked pads.
      const fallback = hole.parent ? +item.diameter || .5 : 0;
      const d = via ? +item.diameter : Math.min(+item.w || fallback, +item.h || fallback);
      if (!(d > drill) || hole.plated === false) continue;
      const min = rules.first("annularRing", hole)?.min;
      if (!Number.isFinite(min) || min <= 0) continue;
      const ring = (d - drill) / 2;
      if (ring + 1e-6 < min || ring >= min + margin - 1e-6) continue;
      const to = Math.ceil((drill + 2 * (min + margin)) * 100 - 1e-6) / 100;
      const subject = padIndex == null ? {ring} : {ring, padIndex, ...G.Atrium.footprintPadKeys(parent.def, item, padIndex, padCount)};
      // A pre-pad-specific dismissal only identifies a hole on a single-hole part.
      const legacyPartDismissal = platedHoles.get(id) === 1;
      out.push({objects: [id], at, land: d / 2, net: net || null, value: ring, subject, legacyPartDismissal,
        message: t("insights.ring.message", {what: t(via ? "insights.ring.via" : "insights.ring.pad"), ring: N3(ring), min: N3(min)}),
        sig: ["ring", N3(ring), N3(min)].join("|"),
        fix: via ? {label: t("insights.ring.fix", {diameter: N(to)}), apply(doc) { const it = doc.items.find(i => i.id === id); if (!it) throw Error("The via is gone."); it.diameter = to; return [id]; }} : null});
    }
    return out;
  }
  // Islands of a pour with a net that link to nothing of that net (polygon-pour.js region.links),
  // each located at a point of the island (its outer ring's area centroid, else its first vertex).
  function deadCheck(ctx) {
    const P = G.AtriumPCBPours, out = [], regions = ctx.doc.pcbDrawing?.pours || [];
    if (!P?.contours) return out;
    for (const reg of regions) {
      const poly = reg.polygon != null ? ctx.byId.get(reg.polygon) : null;
      if (!poly || poly.kind !== "polygon" || !poly.net || poly.shelved || poly.cutout || (reg.links || []).length) continue;
      let rings;
      try { rings = P.contours(reg); } catch { rings = null; }
      const r = rings?.[0];
      if (!r || r.length < 6) continue;
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, n = r.length >> 1, j = n - 1; i < n; j = i++) { const c = r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; a += c; cx += (r[2 * j] + r[2 * i]) * c; cy += (r[2 * j + 1] + r[2 * i + 1]) * c; }
      let area = Math.abs(a) / 2;
      for (const h of rings.slice(1)) { let s2 = 0; for (let i = 0, n = h.length >> 1, j = n - 1; i < n; j = i++) s2 += h[2 * j] * h[2 * i + 1] - h[2 * i] * h[2 * j + 1]; area -= Math.abs(s2) / 2; }
      const at = a ? [cx / (3 * a), cy / (3 * a)] : [r[0], r[1]];
      const name = poly.name || (poly.net + " on " + layerName(poly.layer));
      out.push({objects: [poly.id], at, net: poly.net, layer: poly.layer, value: area, message: t("insights.dead.message", {name, area: N(area), net: poly.net}),
        sig: ["dead", Math.round(at[0] * 2), Math.round(at[1] * 2)].join("|"),
        fix: {label: t("insights.dead.fix"), apply(doc) { const it = doc.items.find(i => i.id === poly.id); if (!it) throw Error("The polygon is gone."); it.removeDeadCopper = true; return [poly.id]; }}});
    }
    return out;
  }
  function pourFailedCheck(ctx) {
    const f = G.AtriumPolygonPour?.failures?.(ctx.doc) || {}, out = [];
    for (const i of ctx.doc.items || []) {
      const x = i.kind === "polygon" && f[i.id];
      if (!x) continue;
      const pts = (Array.isArray(i.points) ? i.points : i.outline || []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (!pts.length) continue;
      const at = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      const name = i.name || ((i.net || "unnamed") + " on " + i.layer);
      out.push({objects: [i.id], at, net: i.net || null, value: 0, message: t("insights.pour.message", {name, reason: x.reason}), sig: ["pour", x.reason].join("|")});
    }
    return out;
  }
  function edgeCheck(ctx, scope) {
    const s = ctx.settings, out = [], O = ctx.doc.outline;
    if (!Array.isArray(O) || O.length < 3) return out;
    let gap = null;
    try { const r = ctx.query?.("boardOutlineClearance", {}); gap = Number.isFinite(r?.gap) ? r.gap : null; } catch { gap = null; }
    if (gap == null) return out;
    const edges = [];
    const rings = [O];
    try { for (const h of G.AtriumBoardShape?.holes?.(ctx.doc) || []) if (Array.isArray(h) && h.length > 2) rings.push(h); } catch { /* outline only */ }
    for (const r of rings) for (let k = 0; k < r.length; k++) edges.push([r[k], r[(k + 1) % r.length]]);
    const g = ctx.grid(4);
    for (const e of edges) g.insert([Math.min(e[0][0], e[1][0]), Math.min(e[0][1], e[1][1]), Math.max(e[0][0], e[1][0]), Math.max(e[0][1], e[1][1])], e);
    const reach = gap + s.margin + 2;
    const nearEdge = (a, b, half) => {
      let best = null;
      g.query([Math.min(a[0], b[0]) - reach, Math.min(a[1], b[1]) - reach, Math.max(a[0], b[0]) + reach, Math.max(a[1], b[1]) + reach], e => {
        const d = ctx.segSeg(a, b, e[0], e[1]) - half;
        if (!best || d < best.d) best = {d, e};
      });
      return best;
    };
    const flag = (id, a, b, half, net) => {
      const r = nearEdge(a, b, half);
      if (!r || r.d + 1e-6 < gap || r.d >= gap + s.margin) return;
      const at = ctx.segDist(r.e[0], a, b).d < ctx.segDist(r.e[1], a, b).d ? ctx.segDist(r.e[0], a, b).at : ctx.segDist(r.e[1], a, b).at;
      const p = a === b ? a : ctx.segDist(at, a, b).at;
      out.push({objects: [id], at: p.slice(), net: net || null, value: r.d, message: t("insights.edge.message", {distance: N(r.d), above: N(r.d - gap), min: N(gap)}), sig: ["edge", Math.round(r.d * 20)].join("|")});
    };
    for (const i of ctx.itemsIn(scope?.boxes || null)) {
      if (i.kind === "track" && COPPER.test(i.layer || "Top") && !i.keepout && Array.isArray(i.points)) {
        const done = out.length;
        for (let k = 1; k < i.points.length && out.length === done; k++) flag(i.id, i.points[k - 1], i.points[k], (+i.width || 0) / 2, i.net);
      } else if (i.kind === "via" && Number.isFinite(i.x)) flag(i.id, [i.x, i.y], [i.x, i.y], (+i.diameter || .6) / 2, i.net);
    }
    return out;
  }

  // ---------------------------------------------------------------- registry
  function install() {
    const R = I()?.register;
    if (!R) return false;
    R({id: "neck", kind: "pcb", severity: "advice", title: t("insights.neck.title"), why: t("insights.neck.why"), prefHelp: () => t("insights.neck.pref_help"), learnMore: t("insights.neck.learn"), scope: "pour", heavy: true, needs: ["AtriumPolygonPour"],
      defaults: {width: {low: .3, normal: .5, high: .8}, ratio: 2.5}, settings: [{key: "width", label: "Neck narrower than", unit: "mm", min: .05, max: 5, step: .05}], run: neckCheck});
    R({id: "returnPlane", kind: "pcb", severity: "advice", title: t("insights.return.title"), why: t("insights.return.why"), prefHelp: () => t("insights.return.pref_help"), learnMore: t("insights.return.learn"), scope: "net", heavy: true,
      needs: ["AtriumSI", "AtriumReturnPath"], alsoKinds: ["polygon", "via"],
      defaults: {viaDistance: {low: 3, normal: 2, high: 1}, capDistance: {low: 8, normal: 5, high: 3}, minVoid: {low: 1, normal: .3, high: .1}, minPartial: {low: 3, normal: 1, high: .5}},
      settings: [{key: "viaDistance", label: "Stitching via within", unit: "mm", min: .2, max: 20, step: .1}, {key: "capDistance", label: "Stitching capacitor within", unit: "mm", min: .5, max: 50, step: .5}],
      run: returnCheck});
    R({id: "acuteAngle", kind: "pcb", severity: "tip", title: t("insights.acute.title"), why: t("insights.acute.why"), prefHelp: () => t("insights.acute.pref_help"), learnMore: t("insights.acute.learn"), scope: "area", reach: 1,
      defaults: {angle: {low: 60, normal: 80, high: 90}}, settings: [{key: "angle", label: "Angles below", unit: "°", min: 10, max: 135, step: 5}], run: acuteCheck});
    R({id: "stub", kind: "pcb", severity: "tip", title: t("insights.stub.title"), why: t("insights.stub.why"), prefHelp: () => t("insights.stub.pref_help"), learnMore: t("insights.stub.learn"), scope: "net",
      defaults: {length: {low: 5, normal: 2, high: 1}}, settings: [{key: "length", label: "Branches longer than", unit: "mm", min: .1, max: 50, step: .1}], run: stubCheck});
    R({id: "widthCurrent", kind: "pcb", severity: "tip", title: t("insights.width.title"), why: t("insights.width.why"), prefHelp: () => t("insights.width.pref_help"), learnMore: t("insights.width.learn"), scope: "net",
      defaults: {margin: {low: 10, normal: 20, high: 30}, rise: 10}, settings: [{key: "margin", label: "Margin over IPC-2152", unit: "%", min: 0, max: 200, step: 5}, {key: "rise", label: "Temperature rise", unit: "°C", min: 1, max: 100, step: 1}],
      run: widthCheck});
    R({id: "thermalCurrent", kind: "pcb", severity: "advice", title: t("insights.thermal.title"), why: t("insights.thermal.why"), prefHelp: () => t("insights.thermal.pref_help"), learnMore: t("insights.thermal.learn"), scope: "net", needs: ["AtriumPolygonPour"], alsoKinds: ["part", "pad"],
      run: thermalCheck});
    R({id: "viaInPad", kind: "pcb", severity: "advice", title: t("insights.vip.title"), why: t("insights.vip.why"), prefHelp: () => t("insights.vip.pref_help"), learnMore: t("insights.vip.learn"), scope: "area", reach: 3, run: vipCheck});
    R({id: "decap", kind: "pcb", severity: "tip", title: t("insights.decap.title"), why: t("insights.decap.why"), prefHelp: () => t("insights.decap.pref_help"), learnMore: t("insights.decap.learn"), scope: "doc", dirtyKinds: ["part", "pad"],
      defaults: {distance: {low: 10, normal: 5, high: 3}}, settings: [{key: "distance", label: "Capacitor farther than", unit: "mm", min: .5, max: 50, step: .5}], run: decapCheck});
    R({id: "diffPair", kind: "pcb", severity: "tip", title: t("insights.pair.title"), why: t("insights.pair.why"), prefHelp: () => t("insights.pair.pref_help"), learnMore: t("insights.pair.learn"), scope: "net", heavy: true, needs: ["AtriumSI"],
      defaults: {near: .8, uncoupled: {low: 10, normal: 5, high: 2.5}, skew: {low: 2.5, normal: 1, high: .5}},
      settings: [{key: "uncoupled", label: "Uncoupled longer than (no rule)", unit: "mm", min: .1, max: 100, step: .5}, {key: "skew", label: "Length skew above", unit: "mm", min: .01, max: 50, step: .05}], run: pairCheck});
    R({id: "crosstalk", kind: "pcb", severity: "tip", title: t("insights.xtalk.title"), why: t("insights.xtalk.why"), prefHelp: () => t("insights.xtalk.pref_help"), learnMore: t("insights.xtalk.learn"), scope: "net", heavy: true, needs: ["AtriumSI"],
      defaults: {next: {low: 5, normal: 3, high: 2}, length: {low: 10, normal: 5, high: 3}},
      settings: [{key: "next", label: "Near-end crosstalk above", unit: "%", min: .1, max: 50, step: .5}, {key: "length", label: "Parallel runs longer than", unit: "mm", min: .5, max: 200, step: .5}], run: xtalkCheck});
    R({id: "silk", kind: "pcb", severity: "tip", title: t("insights.silk.title"), why: t("insights.silk.why"), prefHelp: () => t("insights.silk.pref_help"), learnMore: t("insights.silk.learn"), scope: "area", reach: 3, run: silkCheck});
    R({id: "ringMin", kind: "pcb", severity: "tip", title: t("insights.ring.title"), why: t("insights.ring.why"), prefHelp: () => t("insights.ring.pref_help"), learnMore: t("insights.ring.learn"), scope: "area", reach: 1, areaInput: ringAreaInput,
      defaults: {margin: {low: .025, normal: .05, high: .075}}, settings: [{key: "margin", label: "Margin above the minimum", unit: "mm", min: .005, max: .5, step: .005}], run: ringCheck});
    R({id: "deadCopper", kind: "pcb", severity: "advice", title: t("insights.dead.title"), why: t("insights.dead.why"), prefHelp: () => t("insights.dead.pref_help"), learnMore: t("insights.dead.learn"), scope: "doc", needs: ["AtriumPolygonPour"], run: deadCheck});
    R({id: "pourFailed", kind: "pcb", severity: "advice", title: t("insights.pour.title"), why: t("insights.pour.why"), prefHelp: () => t("insights.pour.pref_help"), learnMore: t("insights.pour.learn"), scope: "doc", run: pourFailedCheck});
    R({id: "edgeCopper", kind: "pcb", severity: "tip", title: t("insights.edge.title"), why: t("insights.edge.why"), prefHelp: () => t("insights.edge.pref_help"), learnMore: t("insights.edge.learn"), scope: "area", reach: 3,
      defaults: {margin: {low: .1, normal: .2, high: .3}}, settings: [{key: "margin", label: "Margin above the minimum", unit: "mm", min: .01, max: 2, step: .05}], run: edgeCheck});
    return true;
  }
  install();
  return Object.freeze({necksOf, padContains, install, releaseSI});
})();
