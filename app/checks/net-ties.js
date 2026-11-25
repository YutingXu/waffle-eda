"use strict";
// Net ties (allowed shorts). A net-tie component deliberately joins two or more
// nets through its own copper, for example a star point between AGND and DGND
// or a Kelvin connection to a sense resistor (EasyEDA "copper bridging",
// Altium "net tie" components).
//
// Library format. A definition is a net tie when its footprint (or its symbol,
// or the definition itself) has netTie:true:
//   footprint: {netTie:true, netTieGroups:[["1","2"]], pads:[...], shapes:[...]}
//   symbol:    {netTie:true, netTieGroups:[["1","2"]], pins:[...]}
// netTieGroups lists the pad (pin) numbers joined by the tie's copper; without
// it every pad is in one group. Copper shapes of the footprint (paths or fills
// on a copper layer) are the tie's bridge: allowed-short copper.
//
// Rules, as used by connectivity.js, rules.js (DRC) and erc.js:
//  - different nets may meet in a tie's copper when each is represented by a
//    pad in the same group on that copper island;
//  - other contacts between different nets are shorts, including through bridge
//    copper outside the intended connection;
//  - clearance is not checked between the tie's own pads and bridge.
// Each net keeps its own ratsnest: the tie never makes net A count as routed
// through net B.
globalThis.AtriumNetTies = (() => {
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const COPPER = /^(Top|Bottom|Multi|Inner (?:[1-9]\d?|1[01]\d|12[0-6]))$/;

  // ---------------------------------------------------------------- library
  const flagged = g => !!g && g.netTie === true;
  const isTieDef = d => !!d && (d.netTie === true || flagged(d.footprint) || flagged(d.symbol));
  // Footprint ties (PCB): the footprint or the definition is flagged.
  const tieFootprint = d => !!d?.footprint && (flagged(d.footprint) || d.netTie === true);
  const tieSymbol = d => !!d?.symbol && (flagged(d.symbol) || d.netTie === true);
  function groups(def, kind = "pcb") {
    const g = kind === "pcb" ? def?.footprint : def?.symbol;
    const numbers = [...new Set(((kind === "pcb" ? g?.pads : g?.pins) || []).map(p => String(p.number ?? "")).filter(Boolean))];
    const raw = Array.isArray(g?.netTieGroups) ? g.netTieGroups : Array.isArray(def?.netTieGroups) ? def.netTieGroups : null;
    if (!raw) return numbers.length ? [numbers] : [];
    return raw.map(list => (Array.isArray(list) ? list : []).map(String).filter(n => numbers.includes(n))).filter(list => list.length);
  }
  // Problems with a net-tie definition, for library editors and imports.
  function check(def) {
    const out = [];
    if (!isTieDef(def)) return out;
    if (def.footprint) {
      const fp = def.footprint, g = groups(def, "pcb");
      if (!g.some(list => list.length >= 2)) out.push("A net tie footprint needs a pad group of at least two pads.");
      const seen = new Set();
      for (const list of g) for (const n of list) { if (seen.has(n)) out.push("Pad " + n + " is in more than one net tie group."); seen.add(n); }
      const bridge = (fp.shapes || []).filter(s => COPPER.test(s.layer || ""));
      if (!bridge.length && !g.some(list => list.length >= 2 && padsTouch(fp, list))) out.push("A net tie footprint needs copper (a track or fill on a copper layer) that joins its pads.");
      if (bridge.some(s => s.net)) out.push("Net tie copper takes its nets from the pads; remove the net from the copper shapes.");
    }
    return out;
  }
  function padsTouch(fp, list) {
    const pads = (fp.pads || []).filter(p => list.includes(String(p.number)));
    for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i], b = pads[j];
      if (Math.abs(a.x - b.x) <= (a.w + b.w) / 2 && Math.abs(a.y - b.y) <= (a.h + b.h) / 2) return true;
    }
    return false;
  }
  // Flag a definition as a net tie (all pads in one group unless given).
  function mark(def, groupList) {
    for (const g of [def.footprint, def.symbol]) if (g) { g.netTie = true; if (groupList) g.netTieGroups = groupList.map(l => l.map(String)); }
    return def;
  }
  // A two-pad SMD net tie: two square pads joined by a bridge track of `width`.
  function make({id = "std-nettie-2", width = .25, pad = .6, gap = .5, layer = "Top"} = {}) {
    const half = gap / 2 + pad / 2, m = .3, u = 1.27, label = String(+width.toFixed(3));
    const pin = (n, x) => ({number: String(n), name: String(n), x, y: 0, electrical: 4});
    const path = (points, style, extra = {}) => ({kind: "path", points, style, closed: false, fill: false, ...extra});
    return {
      id, name: "Net Tie 2-pad " + label + " mm", category: "Net ties", prefix: "NT", value: "Net Tie",
      description: "Joins two nets through a " + label + " mm copper bridge (allowed short).",
      symbol: {netTie: true, netTieGroups: [["1", "2"]], pins: [pin(1, -2 * u), pin(2, 2 * u)],
        shapes: [path([[-2 * u, 0], [-.6 * u, 0]], "pin"), path([[2 * u, 0], [.6 * u, 0]], "pin"),
          {...path([[-.6 * u, 0], [.6 * u, 0]], "body"), width: .5}]},
      footprint: {name: "NetTie-2_SMD_" + label + "mm", netTie: true, netTieGroups: [["1", "2"]],
        pads: [{number: "1", x: -half, y: 0, w: pad, h: pad, drill: 0, shape: "rect", angle: 0},
          {number: "2", x: half, y: 0, w: pad, h: pad, drill: 0, shape: "rect", angle: 0}],
        shapes: [path([[-half, 0], [half, 0]], "copper", {layer, width}),
          // Silk outline clear of the mask openings (pad + 0.1 mm expansion + 0.1 mm silk-to-mask).
          {kind: "path", points: [[-half - pad / 2 - m, -pad / 2 - m], [half + pad / 2 + m, -pad / 2 - m], [half + pad / 2 + m, pad / 2 + m], [-half - pad / 2 - m, pad / 2 + m]], style: "silk", closed: true, fill: false, width: .12}]}
    };
  }
  const starter = () => make();

  // ---------------------------------------------------------------- board parts
  const defOf = (defs, item) => defs?.get?.(item?.def);
  const isTiePart = (item, defs) => item?.kind === "part" && tieFootprint(defOf(defs, item));
  function partIds(doc, defs) {
    const out = new Set();
    for (const i of doc?.items || []) if (isTiePart(i, defs)) out.add(i.id);
    return out.size ? out : null;
  }
  const padNet = (part, pad) => own(part.pinNets, pad.number) ? part.pinNets[pad.number] || "" : pad.net || "";
  // Net-tie parts of a board: [{item, def, groups:[[numbers]], nets:[[net per pad]], tied:[net...]}].
  function parts(doc, defs) {
    const out = [];
    for (const item of doc?.items || []) {
      if (!isTiePart(item, defs)) continue;
      const def = defOf(defs, item), g = groups(def, "pcb"), pads = def.footprint.pads || [];
      const nets = g.map(list => list.map(n => { const p = pads.find(q => String(q.number) === n); return p ? padNet(item, p) : ""; }));
      out.push({item, def, groups: g, nets, tied: [...new Set(nets.flat().filter(Boolean))].sort()});
    }
    return out;
  }
  // DRC clearance between a tie's own pads and bridge, and between the bridge and
  // copper of the nets it ties, is not checked: that copper may touch. Features
  // carry the owning object id (the part) and a label ("Pad NT1-1", "Track …").
  function drcTies(doc, defs) {
    const map = new Map();
    for (const t of parts(doc, defs)) map.set(t.item.id, new Set(t.tied));
    if (!map.size) return null;
    const bridge = f => map.has(f.id) && !/^Pad /.test(f.label || "");
    return {has: id => map.has(id), skip(a, b) {
      if (a.id === b.id && map.has(a.id)) return true;
      return bridge(a) && map.get(a.id).has(b.net) || bridge(b) && map.get(b.id).has(a.net);
    }};
  }
  // The net DRC gives unnamed bridge copper of a tie part (the first tied net),
  // so it is checked for clearance against other nets. null for other parts.
  function bridgeNet(item, defs) {
    if (!isTiePart(item, defs)) return null;
    const def = defOf(defs, item), pads = def.footprint.pads || [];
    for (const list of groups(def, "pcb")) for (const n of list) {
      const p = pads.find(q => String(q.number) === n), net = p ? padNet(item, p) : "";
      if (net) return net;
    }
    return null;
  }

  // ---------------------------------------------------------------- connectivity hook
  // prepare(doc, defs, entities) -> null without net ties, else a helper:
  //   skip(a, b)   true when the contact of entities a and b runs through a tie
  //                (its bridge, or two of its pads); connectivity records it with
  //                touch(a, b) instead of joining the nets.
  //   resolve(union) joins same-net copper across the bridge and returns
  //                {shorts, allowed}: unauthorized shorts through a tie and the
  //                allowed ties [{ref, id, nets}].
  function prepare(doc, defs, entities) {
    const ties = new Map();
    for (const t of parts(doc, defs)) ties.set(t.item.id, t);
    if (!ties.size) return null;
    const role = new Array(entities.length).fill(null);
    entities.forEach((e, n) => {
      const t = ties.get(e.id);
      if (!t) return;
      let slot = "";
      try { slot = String(JSON.parse(e.key)[1] ?? ""); } catch { slot = ""; }
      const m = /^(pad|shape)(\d+)$/.exec(slot);
      if (!m) return;
      if (m[1] === "shape") { role[n] = {tie: t.item.id, bridge: true}; return; }
      const pad = t.def.footprint.pads?.[Number(m[2])], num = pad ? String(pad.number) : "";
      const group = t.groups.findIndex(list => list.includes(num));
      if (group >= 0) role[n] = {tie: t.item.id, bridge: false, group};
    });
    const contacts = [];
    const skip = (a, b) => {
      const ra = role[a], rb = role[b];
      return !!(ra?.bridge || rb?.bridge || ra && rb && ra.tie === rb.tie);
    };
    const touch = (a, b) => { if (a !== b) contacts.push([a, b]); };
    // Sparse disjoint sets for contacts, with path compression and union by size.
    function islands() {
      const parent = new Map(), size = new Map();
      function root(n) {
        let r = n;
        while (parent.has(r)) r = parent.get(r);
        while (n !== r) {
          const next = parent.get(n);
          parent.set(n, r);
          n = next;
        }
        return r;
      }
      function join(a, b) {
        a = root(a); b = root(b);
        if (a === b) return false;
        const sa = size.get(a) || 1, sb = size.get(b) || 1;
        if (sa < sb) [a, b] = [b, a];
        parent.set(b, a);
        size.set(a, sa + sb);
        size.delete(b);
        return true;
      }
      return {root, join};
    }
    function resolve(union) {
      if (!contacts.length) return {shorts: [], allowed: []};
      // Named nets of each ordinary copper root, before any tie-specific joins.
      const netsOf = new Map();
      entities.forEach((e, n) => {
        if (!e.net) return;
        const r = union.root(n);
        if (!netsOf.has(r)) netsOf.set(r, new Set());
        netsOf.get(r).add(e.net);
      });
      // Find each island formed by a single tie's copper before inspecting outside contacts.
      const localLinks = islands(), clusters = new Map();
      for (const [a, b] of contacts) {
        if (role[a] && role[a].tie === role[b]?.tie) localLinks.join(a, b);
      }
      function cluster(n, witness) {
        const id = localLinks.root(n);
        if (!clusters.has(id)) clusters.set(id, {id, tie: role[n].tie, local: new Set(), external: new Map(), witness});
        const island = clusters.get(id);
        island.local.add(n);
        return island;
      }
      const outsideLinks = islands(), unassigned = new Map(), connections = [];
      function connect(a, b, witness) {
        if (outsideLinks.join(a, b)) connections.push({a, b, witness});
      }
      function connectUnassigned(id, root, witness) {
        if (!unassigned.has(root)) unassigned.set(root, id);
        else connect(id, unassigned.get(root), witness);
      }
      for (const [a, b] of contacts) {
        const ra = role[a], rb = role[b];
        if (ra && ra.tie === rb?.tie) {
          cluster(a, [a, b]).local.add(b);
        } else if (ra?.bridge && rb?.bridge) {
          const witness = [a, b];
          connect(cluster(a, witness).id, cluster(b, witness).id, witness);
        } else {
          const [other, bridge] = ra?.bridge ? [b, a] : [a, b];
          cluster(bridge, [other, bridge]).external.set(other, bridge);
        }
      }
      const shorts = [], allowed = [], joins = [], classified = new Map();
      function coveredBy(names, group) {
        if (group.size < names.size) return false;
        for (const net of names) if (!group.has(net)) return false;
        return true;
      }
      function report(names, [a, b]) {
        const e = entities[a], f = entities[b], t = ties.get(role[b].tie);
        shorts.push({nets: [...names].sort(), direct: true,
          from: e.anchors[0].at, to: f.anchors[0].at, fromId: e.id, toId: f.id, fromLabel: e.label,
          toLabel: role[b].bridge ? (t.item.ref || "Net tie") + " net tie copper" : f.label, netTie: t.item.ref || t.item.id});
      }
      for (const {id, tie, local, external, witness} of clusters.values()) {
        const t = ties.get(tie), groups = new Map(), padNets = new Set(), names = new Set(), byNet = new Map();
        // Keep the ordinary copper roots intact while classifying every island.
        function record(n, found) {
          for (const net of found) names.add(net);
          if (found.size !== 1) return;
          const net = found.values().next().value;
          if (byNet.has(net)) joins.push([byNet.get(net), n]);
          else byNet.set(net, n);
        }
        for (const n of local) {
          const net = entities[n].net, r = role[n], root = union.root(n), rootNets = netsOf.get(root);
          if (net && !r.bridge) {
            if (!groups.has(r.group)) groups.set(r.group, new Set());
            groups.get(r.group).add(net);
            padNets.add(net);
          }
          // A named pad represents its assignment; a nameless pad can still conduct
          // from ordinary copper without authorizing that ordinary copper's net.
          if (rootNets && (!net || rootNets.size === 1)) record(n, rootNets);
          else if (net) names.add(net);
          else if (!r.bridge) connectUnassigned(id, root, witness);
        }
        let unsupported = null;
        const visited = new Set();
        for (const [other, bridge] of external) {
          const root = union.root(other);
          if (visited.has(root)) continue;
          visited.add(root);
          const found = netsOf.get(root);
          if (found) {
            record(other, found);
            if (!unsupported && !coveredBy(found, padNets)) unsupported = [other, bridge];
          } else connectUnassigned(id, root, [other, bridge]);
        }
        for (const represented of groups.values()) {
          if (represented.size >= 2) allowed.push({ref: t.item.ref || "", id: t.item.id, nets: [...represented].sort()});
        }
        const localShort = names.size >= 2 && ![...groups.values()].some(group => coveredBy(names, group));
        classified.set(id, {names, groups, byNet, localShort});
        if (localShort) report(names, unsupported || witness);
      }
      // Ordinary copper with no named nets can carry contact between local islands.
      // Assigned ordinary roots stop these connections so a shared return does not
      // merge the allowed groups of otherwise independent net ties.
      const connected = new Map();
      for (const {a, b, witness} of connections) {
        const root = outsideLinks.root(a);
        if (!connected.has(root)) connected.set(root, {ids: new Set(), witness});
        const {ids} = connected.get(root);
        ids.add(a); ids.add(b);
      }
      for (const {ids, witness} of connected.values()) {
        const members = [...ids].map(id => classified.get(id)), names = new Set();
        for (const member of members) for (const net of member.names) names.add(net);
        if (names.size === 1) {
          const net = names.values().next().value;
          const nodes = members.map(m => m.byNet.get(net)).filter(n => n !== undefined);
          for (let k = 1; k < nodes.length; k++) joins.push([nodes[0], nodes[k]]);
        }
        if (names.size < 2) continue;
        // An authorization must be complete on one local island. Do not assemble
        // a declared pad group out of pad contacts connected by outside copper.
        if (members.some(m => [...m.groups.values()].some(group => coveredBy(names, group)))) continue;
        if (members.some(m => m.localShort && coveredBy(names, m.names))) continue;
        report(names, witness);
      }
      // The tie can close gaps within one net; its other nets keep independent roots.
      for (const [a, b] of joins) union.join(a, b);
      allowed.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
      return {shorts, allowed};
    }
    return {skip, touch, resolve, ties};
  }

  // ---------------------------------------------------------------- ERC hook
  // erc({project, defs, graphs, report}): for each schematic net-tie part, a
  // group whose pins share one net ties the net to itself, and a schematic net
  // carrying two of the tied names is a short outside the tie.
  function erc({defs, graphs, report}) {
    const A = globalThis.Atrium;
    for (const g of graphs || []) {
      const doc = g.doc;
      for (const item of doc.items) {
        if (item.kind !== "part") continue;
        const def = defs.get(item.def);
        if (!tieSymbol(def) && !(isTieDef(def) && def.symbol)) continue;
        const pins = A.pins(item, def, "schematic");
        const tied = new Set();
        for (const list of groups(def, "schematic")) {
          const names = list.map(n => g.byPin.get(item.id + "/" + n)).filter(Boolean);
          const distinct = [...new Set(names)];
          if (names.length >= 2 && distinct.length === 1) {
            // One net on every pin: either the tie's nets are shorted on the sheet, or it ties a net to itself.
            const net = g.nets.find(x => x.name === distinct[0]);
            if (net && net.names.size > 1) {
              const src = net.sources.find(x => x.name !== net.name) || net.sources[0];
              report("netTies", doc, "Nets " + [...net.names].sort().join(" and ") + " are shorted outside net tie " + item.ref, src?.item || item);
            } else report("netTies", doc, "Net tie " + item.ref + " connects net " + distinct[0] + " to itself", item, pins.find(p => list.includes(String(p.number)))?.at);
          }
          distinct.forEach(n => tied.add(n));
        }
        if (tied.size < 2) continue;
        for (const net of g.nets) {
          const both = [...net.names].filter(n => tied.has(n));
          if (both.length < 2) continue;
          const src = net.sources.find(s => both.includes(s.name) && s.name !== net.name) || net.sources[0];
          report("netTies", doc, "Nets " + both.join(" and ") + " are shorted outside net tie " + item.ref, src?.item || item);
        }
      }
    }
  }

  return Object.freeze({isTieDef, tieFootprint, tieSymbol, groups, check, mark, make, starter, isTiePart, partIds, parts, drcTies, bridgeNet, prepare, erc});
})();
