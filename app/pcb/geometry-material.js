"use strict";
if (typeof require === "function") {
  if (!globalThis.AtriumGeometryCurves) require("./resolved-geometry-curves.js");
  if (!globalThis.AtriumBoardShape) require("./board-shape-core.js");
  if (!globalThis.AtriumStackup) require("./stackup.js");
  if (!globalThis.AtriumViaStack) require("./viastack.js");
  if (!globalThis.AtriumSpatial) require("../core/spatial.js");
  if (!globalThis.AtriumPolygonPour) require("./polygon-pour.js");
}

globalThis.AtriumGeometryMaterial = (() => {
  const G = globalThis, TOL = .001, EPS = 1e-8;
  const pcb = () => G.AtriumPCBAppearance;
  const curves = () => G.AtriumGeometryCurves;
  const line = (a, b) => ({kind: "line", a, b});
  const arc = (center, radius, start, sweep) => ({kind: "arc", center, radius, start, sweep});
  const ring = points => points.map((p, i) => line(p, points[(i + 1) % points.length]));
  const circle = (at, r) => [arc(at, r, 0, 180), arc(at, r, 180, 180)];
  const round = n => Math.round(n * 1e9) / 1e9 + 0;
  const defsOf = project => new Map((project?.library || []).map(d => [d.id, d]));

  function datum(doc, defs) {
    const S = G.AtriumStackup;
    const stored = S.stored(doc), stack = stored || S.derive(doc, defs);
    const valid = doc.stackup == null || !!stored;
    const depths = S.layerDepths(stack), dielectric = depths.filter(p => p.row.type === "Dielectric");
    const origin = dielectric.at(-1)?.end, top = dielectric[0]?.z;
    const resolved = valid && origin > top;
    const topCopper = stack.layers.findIndex(S.isCopper);
    const layers = depths.map(({row, z, end}, i) => {
      const kind = S.isCopper(row) ? "copper" : row.type === "Dielectric" ? "dielectric"
        : row.type === "Solder Mask" ? "mask" : row.type === "Overlay" ? "legend" : "mechanical";
      const side = i > topCopper ? "Bottom" : "Top";
      const name = row.key || (kind === "mask" ? side + " mask" : kind === "legend"
        ? side === "Bottom" ? "Bottom silk" : "Silk" : row.name);
      return {name, kind, z: resolved ? [round(origin - end), round(origin - z)] : null};
    });
    return datumFromLayers(layers, S.thickness(doc, defs, stack));
  }
  function datumFromLayers(layers, nominal) {
    const physical = layers.filter(row => row.z), dielectric = physical.filter(row => row.kind === "dielectric");
    const copper = new Map(layers.filter(row => row.kind === "copper").map(row => [row.name, row.z]));
    const substrate = dielectric.length ? [0, Math.max(...dielectric.map(row => row.z[1]))] : null;
    nominal ??= physical.length ? Math.max(...physical.map(row => row.z[1])) - Math.min(...physical.map(row => row.z[0])) : 0;
    return {layers, copper, nominal, substrate};
  }
  function layers(doc, project) {
    const PCB = pcb(), defs = defsOf(project), result = datum(doc, defs).layers;
    const seen = new Set(result.map(layer => layer.name));
    function add(name) {
      if (!name || name === "Multi" || PCB.index(name) >= 0 || seen.has(name)) return;
      const kind = / paste$/.test(name) ? "paste" : / mask$/.test(name) ? "mask" : /silk$/i.test(name) ? "legend"
        : /(^Drill |^Annotation)/.test(name) ? "annotation" : "mechanical";
      result.push({name, kind, z: null});
      seen.add(name);
    }
    for (const name of ["Outline", "Top mask", "Bottom mask", "Top paste", "Bottom paste", "Silk", "Bottom silk"]) add(name);
    for (const item of doc.items || []) {
      if (item.kind !== "part") { add(PCB.boardLayer(item)); continue; }
      const footprint = PCB.readDefinition(defs, item.def, doc)?.footprint;
      for (const pad of footprint?.pads || []) add(PCB.padLayer(item, pad));
      for (const shape of footprint?.shapes || []) add(PCB.shapeLayer(item, shape));
      for (const label of PCB.sourceLabels(doc, item) || []) add(label.layer);
    }
    return result;
  }
  const copperLayers = rows => rows.filter(row => row.kind === "copper").map(row => row.name);
  const overlapsZ = (span, z) => span && z && (z[0] === z[1]
    ? span[0] - EPS <= z[0] && span[1] + EPS >= z[1]
    : span[0] + EPS < z[1] && span[1] - EPS > z[0]);

  function spanOf(item, keys) {
    return pcb().copperSpan(item, key => keys.indexOf(key), keys.length - 1)?.map(i => keys[i]) ?? null;
  }

  // Source board coordinates. The resolver rebases the owner and transforms the cutter for each panel occurrence.
  // Plot metadata is a separate callback argument and does not enter the public Bore.
  function visitPad(pad, parent, keys, copper, member, defaults, bore, diagnose) {
    const via = pad.kind === "via", d = pad.drill;
    if (!(d > 0)) return;
    const PCB = pcb(), VS = G.AtriumViaStack, at = PCB.padCenter(pad, parent);
    const plated = via || PCB.padPlated(pad, parent);
    const through = [keys[0], keys.at(-1)];
    const authored = via || plated && PCB.padLayer(parent, pad) === "Multi" ? spanOf(pad, keys) : through;
    const [from, to] = authored || [pad.fromLayer ?? through[0], pad.toLayer ?? through[1]];
    const A = copper.get(from), B = copper.get(to);
    const z = authored && A && B ? [B[0], A[1]] : null;
    if (!z) diagnose(member, "unknown-bore-depth");
    const core = via ? [at] : G.Atrium.drillCore(pad, at, PCB.padTurn(pad, parent));
    const cutter = core.length > 1 ? {kind: "slot", centerline: [line(...core)], diameter: d}
      : {kind: "round", at, diameter: d};
    const operations = via ? VS.drillSpans(pad, keys) : [];
    const treatment = via ? {ipc4761: VS.IPC[pad.ipc4761]?.id || "none", ipcSides: pad.ipcSides ?? null,
      tented: {top: VS.covered(pad, "top") ?? !!defaults?.tentTop, bottom: VS.covered(pad, "bottom") ?? !!defaults?.tentBottom}} : null;
    bore(member, {operation: "primary", plated, cutter, from, to, z, treatment},
      {at, endpoints: core.length > 1 ? core : undefined, via, laser: !!operations[0]?.laser, pad, parent});
    const back = operations.find(op => op.role === "backdrill");
    if (!back) return;
    const stop = copper.get(back.stopLayer), backMember = [...member, "backdrill"];
    const limit = stop && VS.backdrillStop(back, stop);
    const backZ = !z || limit == null ? null : back.side === "top" ? [limit, z[1]] : [z[0], limit];
    const physical = backZ?.[0] < backZ?.[1] ? backZ.map(round) : null;
    if (!physical) diagnose(backMember, "unknown-backdrill-depth");
    bore(backMember, {operation: "backdrill", plated: false, cutter: {kind: "round", at, diameter: back.drill},
      from: back.from, to: back.to, z: physical, primary: member}, {at, via, side: back.side, stop: back.stopLayer, stub: back.stubMax, pad, parent});
  }

  function collect({doc, defs, item, layers: occupied, copper, defaults, bore, diagnose}) {
    if (!item || !["pad", "via", "part"].includes(item.kind)) return;
    copper ??= new Map(occupied.filter(layer => layer.kind === "copper").map(layer => [layer.name, layer.z]));
    const keys = [...copper.keys()];
    const emit = (pad, parent, member) => visitPad(pad, parent, keys, copper, member, defaults, bore, diagnose);
    if (item.kind === "pad" || item.kind === "via") emit(item, null, []);
    else if (item.kind === "part") {
      const pads = pcb().readDefinition(defs, item.def, doc)?.footprint?.pads;
      pads?.forEach((pad, i) => emit(pad, item, ["pad", String(i)]));
    }
  }

  const bounds = points => points.reduce(([x0, y0, x1, y1], [x, y]) =>
    [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const merge = ([a,b,c,d], [e,f,g,h]) => [Math.min(a,e), Math.min(b,f), Math.max(c,g), Math.max(d,h)];
  const overlaps = (a, b) => G.AtriumSpatial.overlaps(a, b);
  const strictlyContains = (a, b) => a[0] < b[0] && a[1] < b[1] && a[2] > b[2] && a[3] > b[3];
  const extend = (box, n) => [box[0] - n, box[1] - n, box[2] + n, box[3] + n];
  const noBounds = () => [Infinity, Infinity, -Infinity, -Infinity];
  function edgeBox(edges) {
    const {edgeBounds} = curves(), box = noBounds();
    for (const edge of edges) edgeBounds(edge, box);
    return box;
  }
  const areaBox = area => area.reduce((box, island) => merge(box, edgeBox(island.outer)), noBounds());
  function cutterBounds(bore) {
    const {cutter: c} = bore;
    return extend(c.kind === "round" ? [...c.at, ...c.at] : edgeBox(c.centerline), c.diameter / 2);
  }
  function cutterArea({cutter}) {
    return cutter.kind === "round" ? [{outer: circle(cutter.at, cutter.diameter / 2), holes: []}]
      : curves().strokeOutline({kind: "stroke", centerline: cutter.centerline, width: cutter.diameter}, TOL);
  }
  const filmArea = ({ink}, separate = false) => ink.kind === "region" ? ink.islands : ink.kind === "flash"
    ? curves().placeArea(ink.aperture, curves().flashFrame(ink)) : separate ? curves().strokePieces(ink, TOL) : curves().strokeOutline(ink, TOL);

  const polygons = new WeakMap();
  function polygon(loop) {
    if (!polygons.has(loop)) polygons.set(loop, curves().flatten(loop, TOL).slice(0, -1));
    return polygons.get(loop);
  }
  function areaRings(area) {
    const directed = (points, sign) => G.AtriumBoardShape.polyArea(points) * sign > 0 ? points : points.slice().reverse();
    return area.flatMap(i => [directed(polygon(i.outer), 1), ...i.holes.map(h => directed(polygon(h), -1))]);
  }
  function boolean(areas, keep) {
    return G.AtriumPolygonPour.boolean(areas.map(areaRings), keep, 1e7)
      .map(({outline, holes}) => ({outer: ring(outline), holes: holes.map(ring)}));
  }
  function containsCutter(loop, entry) {
    const {box, bore} = entry, {cutter} = bore;
    const [a, b] = loop;
    if (loop.length <= 2 && a?.kind === "arc" && (!b || b.kind === "arc" && b.radius === a.radius &&
      b.center[0] === a.center[0] && b.center[1] === a.center[1]) && Math.abs(a.sweep + (b?.sweep || 0)) === 360 &&
      cutter.kind === "round")
      return Math.hypot(a.center[0] - cutter.at[0], a.center[1] - cutter.at[1]) + cutter.diameter / 2 < a.radius - EPS;
    const points = polygon(loop), safe = extend(box, TOL * 2);
    return strictlyContains(edgeBox(loop), safe) && G.AtriumGeometry.inRingAt(safe[0], safe[1], points) &&
      !points.some((p, i) => overlaps(bounds([p, points[(i + 1) % points.length]]), safe));
  }
  function subtract(area, entries) {
    if (!area.length || !entries.length) return area;
    // A larger concentric backdrill subsumes its primary for this Z band.
    const roundEntries = new Map(), separate = [];
    for (const entry of entries) {
      const {cutter} = entry.bore;
      if (cutter.kind === "round") {
        const at = cutter.at.join(",");
        if (!(roundEntries.get(at)?.bore.cutter.diameter >= cutter.diameter)) roundEntries.set(at, entry);
      } else separate.push(entry);
    }
    entries = [...roundEntries.values(), ...separate];
    const only = area.length === 1 ? area[0] : null;
    if (only && entries.every(entry => containsCutter(only.outer, entry) &&
      !only.holes.some(h => overlaps(edgeBox(h), entry.box))) &&
      (entries.length === 1 || disjoint(entries))) {
      return [{outer: only.outer, holes: [...only.holes, ...entries.flatMap(entry => cutterArea(entry.bore).map(i => i.outer))]}];
    }
    return boolean([area, entries.flatMap(entry => cutterArea(entry.bore))], w => w[0] !== 0 && w[1] === 0);
  }
  function disjoint(entries) {
    const index = G.AtriumSpatial.create([], entry => entry.box);
    for (const [i, entry] of entries.entries()) {
      if (index.query(entry.box).length) return false;
      index.insert(entry, i);
    }
    return true;
  }
  function cutterIndex(bores) {
    const entries = Array.from(bores, bore => ({bore, box: cutterBounds(bore)}));
    return G.AtriumSpatial.create(entries, entry => entry.box);
  }
  function slice(area, index, z) {
    if (!area.length || !z) return [];
    const entries = index.query(areaBox(area)).filter(({bore}) => overlapsZ(bore.z, z));
    const boundaries = new Set(z);
    for (const {bore} of entries) for (const depth of bore.z)
      if (z[0] + EPS < depth && depth < z[1] - EPS) boundaries.add(depth);
    const levels = [...boundaries].sort((a, b) => a - b);
    return levels.slice(1).map((top, i) => {
      const interval = [levels[i], top];
      return {area: subtract(area, entries.filter(({bore}) => overlapsZ(bore.z, interval))), z: interval};
    });
  }
  function clip(area, index, z) {
    if (!area.length || !z) return area;
    return subtract(area, index.query(areaBox(area)).filter(({bore}) => overlapsZ(bore.z, z)));
  }
  function featureArea(feature, bores, stage, {layers: occupied, index} = {}) {
    const area = filmArea(feature);
    if (stage !== "finished") return area;
    const layer = occupied?.find(l => l.name === feature.key.layer);
    return layer?.kind === "copper" ? clip(area, index || cutterIndex(bores), layer.z) : area;
  }
  function compose(features) {
    const parts = [...features].map(feature => {
      const area = filmArea(feature);
      return {area, box: areaBox(area), positive: feature.polarity !== "clear"};
    }).filter(part => part.area.length);
    if (parts.length < 2) return parts[0]?.positive ? parts[0].area : [];
    const index = G.AtriumSpatial.create(parts, part => part.box), seen = new Set(), positions = new Map(parts.map((part, i) => [part, i]));
    return parts.flatMap(seed => {
      if (seen.has(seed)) return [];
      const connected = [seed];
      seen.add(seed);
      for (const part of connected) for (const near of index.query(part.box)) {
        if (seen.has(near)) continue;
        seen.add(near);
        connected.push(near);
      }
      if (connected.length === 1) return seed.positive ? seed.area : [];
      connected.sort((a, b) => positions.get(a) - positions.get(b));
      return boolean(connected.map(part => part.area), w => {
        for (let i = w.length - 1; i >= 0; i--) if (w[i] !== 0) return connected[i].positive;
        return false;
      });
    });
  }
  function layerArea(features, bores, name, stage, box, z, {layers: occupied, index} = {}) {
    let area = compose([...features].filter(f => f.key.layer === name && (!box || !f.bounds || overlaps(f.bounds, box))));
    if (box && area.length) {
      const [a,b,c,d] = box;
      if (!strictlyContains(box, areaBox(area))) area = boolean([area, [{outer: ring([[a,b],[c,b],[c,d],[a,d]]), holes: []}]], w => w[0] !== 0 && w[1] !== 0);
    }
    const layer = occupied?.find(l => l.name === name);
    return stage === "finished" && (layer?.kind === "copper" || layer?.kind === "dielectric")
      ? clip(area, index || cutterIndex(bores), Number.isFinite(z) ? [z, z] : layer.z) : area;
  }

  return Object.freeze({datum, layers, copperLayers, collect, spanOf, visitPad, featureArea, layerArea,
    datumFromLayers, cutterArea, cutterBounds, cutterIndex, clip, slice, overlapsZ, filmPieces: feature => filmArea(feature, true)});
})();
