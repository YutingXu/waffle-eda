"use strict";
// Return Path rule: reference plane continuity under high-speed tracks, as DRC violations that
// are navigable on the board, each with a suggested fix. The analysis is si.js (AtriumSI):
// copper on the reference layers under the centre line and both edges of every track piece, and
// the references on each side of every layer-changing via.
//
//   voids         no copper under the track on its nominal reference layer (antipads of the net's
//                 own vias excepted), or only under part of its width
//   splits        the track straddles, or crosses, a boundary between two reference nets
//   layerChange   the references before and after a via differ: the same net on two layers needs
//                 a stitching via within `distance`; different nets need a stitching capacitor
//                 within `capDistance`
// Fixes: suggest(...) proposes a stitching via site (8 directions around the signal via, clear of
// other copper) for a missing return via; splits and voids suggest rerouting or a stitching
// capacitor. A violation carries fix: {kind:"via", net, at, from, to} when a site was found;
// apply(doc, fix) adds the via (one undo step in the UI).
//
//   drc(doc, defs, {R, rules, flag, notes, project}) (rules.js) · suggest(ctx, row) · apply(doc, fix)
globalThis.AtriumReturnPath = (() => {
  const EPS = 1e-6;
  const r3 = v => Math.round(v * 1000) / 1000 + 0;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // net-intent.js (isSupply) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(String(n ?? "")) : POWER_RE.test(n); }};
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
  }
  // A stitching via site near `at`: free of other nets' tracks and holes by `clear`.
  function suggest(ctx, row, o = {}) {
    const via = ctx.vias.find(v => v.id === row.via), r = via?.r ?? .3, size = o.viaDiameter ?? .6, clear = o.clearance ?? .2;
    const ring = Math.max(r + size / 2 + clear, Math.min(o.distance ?? 1, r + size + clear) * .9);
    const ref = (row.refsFrom || []).find(a => (row.refsTo || []).some(b => b.net === a.net))?.net;
    if (!ref) return null;
    for (let k = 0; k < 16; k++) {
      const ang = (k % 8) * Math.PI / 4 + (k >= 8 ? Math.PI / 8 : 0), d = k >= 8 ? ring * 1.25 : ring;
      const p = [row.at[0] + d * Math.cos(ang), row.at[1] + d * Math.sin(ang)];
      let ok = true;
      ctx.near(p, p, size / 2 + clear + 1, s => { if (ok && s.net !== ref && segDist(p, s.a, s.b) < s.w / 2 + size / 2 + clear) ok = false; });
      if (ok) ctx.holesNear(p, size + clear + 1, h => { if (ok && h.net !== ref && dist(h.at, p) < h.r + size / 2 + clear) ok = false; });
      if (ok && o.outline && !inside(p, o.outline)) ok = false;
      if (ok) return {kind: "via", net: ref, at: [r3(p[0]), r3(p[1])], diameter: size, from: row.from, to: row.to};
    }
    return null;
  }
  function inside(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  // Add the suggested through via (the caller wraps this in an undo step).
  function apply(doc, fix, o = {}) {
    if (!fix || fix.kind !== "via") throw Error("No stitching via to add.");
    const id = (globalThis.Atrium?.id?.() ?? "via-" + Math.random().toString(36).slice(2, 10));
    const v = {id, kind: "via", net: fix.net, x: fix.at[0], y: fix.at[1], diameter: fix.diameter || .6, drill: o.drill ?? Math.max(.2, (fix.diameter || .6) / 2)};
    doc.items.push(v);
    return v;
  }
  function drc(doc, defs, {rules, flag, notes, project}) {
    const SI = globalThis.AtriumSI;
    if (!SI) { notes.push("Return path checks need the signal integrity module (si.js)."); return; }
    const nets = new Set();
    for (const i of doc.items || []) if (i.kind === "track" && i.net && !POWER.test(i.net)) nets.add(i.net);
    // Nets by the first rule that scopes them; one analysis per rule (its distances).
    const byRule = new Map();
    for (const net of nets) { const r = rules.find(x => x.m1({kind:"net",name:net,net})); if (!r) continue; if (!byRule.has(r)) byRule.set(r, []); byRule.get(r).push(net); }
    for (const [r, list] of byRule) {
      let rep, ctx;
      try {
        ctx = SI.context(doc, defs, {project, returnRadius: r.distance, capRadius: r.capDistance, minVoid: r.minVoid});
        rep = SI.analyze(doc, defs, {context: ctx, nets: list.sort()});
      } catch (e) { notes.push("Return path: " + e.message); continue; }
      const seen = new Set();
      for (const e of rep.events) {
        const isVoid = e.kind === "void" || e.kind === "partial" || e.kind === "no-reference", isSplit = e.kind === "split" || e.kind === "split-crossing";
        if (isVoid && r.voids === false || isSplit && r.splits === false) continue;
        if (isVoid && e.kind !== "no-reference" && (e.length ?? 0) < (r.minVoid ?? 0) - EPS) continue;
        const k = e.kind + e.id + e.ref + Math.round(e.at[0] * 100) + "," + Math.round(e.at[1] * 100); if (seen.has(k)) continue; seen.add(k);
        const fix = isSplit ? "Route over continuous " + (e.from || "reference") + " copper, or place a stitching capacitor between " + (e.from || "the planes") + " and " + (e.to || "the other plane") + " where the track crosses."
          : e.kind === "no-reference" ? "Move the track to a layer next to a plane, or add a plane under it." : "Fill the void on " + e.ref + " under the track, or reroute around it.";
        flag(r, {id: e.id, title: "Net " + e.net + " (" + e.layer + ")", what: isSplit ? "Plane split" : e.kind === "no-reference" ? "No reference plane" : "Reference void",
          detail: e.detail + ". Fix: " + fix, at: e.at, kind: e.kind, reference: e.ref || null, ...(e.length != null ? {actual: e.length} : {})});
      }
      if (r.layerChange !== false) for (const x of rep.returns) {
        if (x.status === "ok") continue;
        const sug = x.kind === "missing-via" ? suggest(ctx, x, {distance: r.distance}) : null;
        const detail = x.kind === "missing-via" ? "Layer change " + x.from + " → " + x.to + (x.chain ? " (" + x.chain.kind + " vias)" : "") + ": no stitching via or via chain within " + r.distance + " mm. Fix: " + (sug ? "add a " + sug.net + " via at (" + sug.at.join(", ") + ")." : "add a via of the reference net next to the signal via (Tools › Stitching › Return Path Vias).")
          : x.kind === "net-change" ? "Reference changes net at " + x.from + " → " + x.to + " with no stitching capacitor within " + r.capDistance + " mm. Fix: place a capacitor between " + [...new Set([...(x.refsFrom || []), ...(x.refsTo || [])].map(q => q.net))].join(" and ") + " next to the via."
          : "No reference plane on one side of the layer change " + x.from + " → " + x.to + ".";
        flag(r, {id: x.via, title: "Net " + x.net + " via " + x.from + " → " + x.to, what: "Return path", detail, at: x.at, kind: x.kind, ...(sug ? {fix: sug} : {}), ...(x.distance != null ? {actual: x.distance} : {})});
      }
    }
  }
  return Object.freeze({drc, suggest, apply});
})();
