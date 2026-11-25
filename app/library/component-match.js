"use strict";
// Physical component correspondence for Update PCB and design comparison. Inputs are compact
// records (see describe). Only equal coordinate spaces are compared: sheet mm are never PCB mm.
// steps() yields during candidate scoring and assignment for cancellable idle/UI consumers.
globalThis.AtriumComponentMatch = (() => {
  const norm = s => String(s ?? "").trim().toUpperCase();
  const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const group = (map, key, value) => {
    let bucket = map.get(key);
    if (!bucket) map.set(key, bucket = []);
    bucket.push(value);
  };
  function passiveRating(prefix, params, value) {
    if (prefix !== "C" && prefix !== "R") return "";
    const raw = String((prefix === "C" ? params.CAPACITANCE : params.RESISTANCE) || value || "").trim();
    const m = raw.length <= 32 && /^(\d+(?:\.\d+)?)\s*([pnumkKMµμ]?)\s*(F|[RΩ]|ohms?)?$/i.exec(raw);
    if (!m || (prefix === "C" ? !/^F$/i.test(m[3] || "") : /^F$/i.test(m[3] || ""))) return "";
    const scale = {"": 1, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6}[m[2]];
    return scale ? (Number(m[1]) * scale).toPrecision(12) : "";
  }
  function describe(p, def, context = {}) {
    const ref = norm(p.ref);
    const prefix = norm(def?.prefix || ref.match(/^[^\d?*]+/)?.[0]);
    const terminals = def?.symbol?.pins || def?.footprint?.pads || [];
    const pinCount = new Set(terminals.filter(t => !t.thermalVia && t.number != null && t.number !== "").map(t => String(t.number))).size;
    // Older pasted selections retained the source ID after minting their own object and link.
    const detachedSource = !!(p.altiumSourceId && p.link && p.link.split("@")[0] !== p.altiumSourceId &&
      !/^a[uc]-/.test(p.id) && !p.schSource && !p.sourceRecord);
    const params = def?.parameters || {};
    const dielectric = [def?.description, params.DIELECTRIC, params["DIELECTRIC MATERIAL"], params["TEMPERATURE CHARACTERISTIC"]].join(" ");
    const polarized = prefix === "C" && (/electrolyt|tantalum|polari[sz]ed/i.test(dielectric) ||
      terminals.some(t => /^(?:[+-]|POS(?:ITIVE)?|NEG(?:ATIVE)?|ANODE|CATHODE)$/i.test(t.name || "")));
    const reversible = !polarized && pinCount === 2 && (prefix === "R" && ((def?.catalogueId || def?.id) === "std-r" || params.RESISTANCE || /resistor/i.test(def?.description || "")) ||
      prefix === "C" && /\b(?:ceramic|MLCC|X[578][RS]|C0G|NP0)\b/i.test(dielectric));
    const functions = /^(?:U|IC)$/.test(prefix) && def?.symbol ? new Map() : null;
    if (functions) for (const pin of def.symbol.pins || []) {
      const name = norm(pin.name);
      if (name && !/^(?:\d+|NC|N\.C\.|DNU|THERMAL PAD)$/.test(name)) functions.set(name, functions.has(name) ? "" : String(pin.number));
    }
    return {
      key: p.id, ids: [p.id], links: p.link ? [p.link] : [], sourceIds: p.altiumSourceId ? [p.altiumSourceId] : [],
      kicadIds: p.kicadSourceId && String(p.link || "").startsWith("kicad-") ? [p.kicadSourceId] : [], ref, value: norm(p.value),
      footprint: norm(def?.footprintName || def?.footprint?.name),
      library: def?.mirrorOf || def?.id || p.def, libraryName: norm(def?.name),
      prefix, pinCount, reversible: !!reversible, polarized, rating: passiveRating(prefix, params, p.value), functions, detachedSource, unit: p.unit || p.part || 1,
      x: p.x, y: p.y, sheet: "", plane: "", scope: "", domain: "", channel: "", room: "",
      pins: () => p.pinNets || {}, ...context
    };
  }
  function boardPins(p, def) {
    const pins = new Map(Object.entries(p.pinNets || {}));
    for (const pad of def?.footprint?.pads || []) {
      const n = String(pad.number ?? "");
      if (n && !pad.thermalVia && !pins.has(n) && pad.net) pins.set(n, pad.net);
    }
    return pins;
  }
  // Some boards remember a channel only in a room or in an expanded link. Room membership
  // is indexed once, including explicit room members on boards made before channel metadata.
  function boardLocations(board) {
    const byPart = new Map(), byChannel = new Map();
    for (const room of board.rooms || []) {
      if (room.channel) byChannel.set(room.channel, room);
      for (const id of room.members || []) byPart.set(id, room);
    }
    return p => {
      const source = board.sync?.locations?.[p.id];
      const path = p.link?.indexOf("@") > 0 ? p.link.slice(p.link.indexOf("@") + 1) : "";
      const room = byPart.get(p.id) || byChannel.get(p.channel || path);
      return {sheet: room?.sheet || source?.sheet || "", channel: path || p.channel || room?.channel || source?.channel || "",
        room: norm(room?.name), source};
    };
  }
  const compatible = (a, b) => a.domain === b.domain && (!a.channel || !b.channel || a.channel === b.channel) && a.unit === b.unit;
  const sameInstances = (a,b) => !a.instances && !b.instances || !!a.instances && !!b.instances &&
    a.instances.length === b.instances.length && a.instances.every((name,i) => name === b.instances[i]);
  const region = (a, b) => JSON.stringify([a.domain, a.scope, a.sheet || b.sheet, a.channel || b.channel,
    b.scope, b.sheet || a.sheet, b.channel || a.channel]);
  const netSpace = p => JSON.stringify([p.domain,p.scope,p.sheet,p.channel]);
  function namesBySpace(parts,pins) {
    const spaces=new Map();
    for(const p of parts){
      const k=netSpace(p);
      if(!spaces.has(k))spaces.set(k,new Set());
      const names=spaces.get(k);
      for(const net of pins(p).values())names.add(net);
    }
    return spaces;
  }
  function pinReader() {
    const cache = new Map();
    return part => {
      if (!cache.has(part)) {
        const value = typeof part.pins === "function" ? part.pins() : part.pins;
        cache.set(part, new Map([...(value instanceof Map ? value : Object.entries(value || {}))]
          .filter(([number, net]) => number && typeof net === "string" && net)));
      }
      return cache.get(part);
    };
  }
  // A board object can survive a schematic library replacement. Joining the two views of
  // either revision requires a unique imported source ID on both the symbol and the footprint.
  function *physicalPeers(parts) {
    const bySource = new Map(), peers = new Map();
    let tick = 0;
    for (const p of parts) {
      if ((++tick & 127) === 0) yield;
      if (p.sourceIds?.length === 1 && !p.detachedSource) group(bySource, p.sourceIds[0], p);
    }
    for (const linked of bySource.values()) {
      if ((++tick & 127) === 0) yield;
      if (linked.length !== 2) continue;
      const [a, b] = linked;
      if (!([a.domain, b.domain].includes("schematic") && [a.domain, b.domain].includes("pcb")) || a.channel !== b.channel) continue;
      peers.set(a, b); peers.set(b, a);
    }
    return peers;
  }
  // A replaced controller may expose the same functions on different pad numbers. Its
  // tentative correspondence can explain a proposal to a reviewer, never certify an identity.
  function *replacementRoles(left, right, pairs, taken, pins, opts) {
    const roles = new Map();
    if (opts.designator === false) return roles;
    let tick = 0;
    function *index(list) {
      const refs = new Map();
      for (const p of list) {
        if ((++tick & 127) === 0) yield;
        if (p.functions?.size && p.ref && !/[?*]/.test(p.ref)) group(refs,JSON.stringify([netSpace(p),p.unit,p.ref]),p);
      }
      return refs;
    }
    const old = yield* index(left), current = yield* index(right), graphs = new Map();
    for (const [key, as] of old) {
      const bs = current.get(key);
      if (as.length !== 1 || bs?.length !== 1) continue;
      const a = as[0], b = bs[0];
      if (pairs.has(a.key) || taken.has(b.key) || a.libraryName === b.libraryName) continue;
      const ports = [];
      for (const [name,num] of a.functions) {
        if (!num || !b.functions.get(name) || /^(?:[APD]?GND|[APD]?VSS\d*)$/.test(name)) continue;
        const n = pins(a).get(num), m = pins(b).get(b.functions.get(name));
        if (n && m) ports.push([n,m]);
      }
      if (ports.length < 3 || !ports.some(([n,m]) => n === m)) continue;
      const space = netSpace(a);
      if (!graphs.has(space)) graphs.set(space, {from:new Map(),to:new Map()});
      const graph = graphs.get(space);
      for (const [n,m] of ports) {
        if (!graph.from.has(n)) graph.from.set(n,new Set());
        if (!graph.to.has(m)) graph.to.set(m,new Set());
        graph.from.get(n).add(m); graph.to.get(m).add(n);
      }
    }
    if (!graphs.size) return roles;
    for (const [parts, side] of [[left,"from"],[right,"to"]]) for (const p of parts) {
      if ((++tick & 127) === 0) yield;
      const graph = graphs.get(netSpace(p));
      if (!graph || !p.prefix) continue;
      const nets = pins(p);
      if (nets.size !== 2) continue;
      const mapped = [], opposite = side === "from" ? graph.to : graph.from;
      let named = false;
      for (const n of nets.values()) {
        const observations = graph[side].get(n);
        if (!observations) { mapped.push(["name",n]); continue; }
        const m = observations.values().next().value;
        if (observations.size !== 1 || opposite.get(m)?.size !== 1) break;
        mapped.push(["function",side === "from" ? n : m]); named = true;
      }
      if (named && mapped.length === 2) roles.set(p,JSON.stringify([netSpace(p),p.unit,p.prefix,mapped.map(k=>JSON.stringify(k)).sort()]));
    }
    return roles;
  }
  function *matchCircuits(left, right, pairs, taken, collisions, pins, opts) {
    const targets = new Map(right.map(p => [p.key, p])), roles = yield* replacementRoles(left,right,pairs,taken,pins,opts);
    const oldPeers = yield* physicalPeers(left), newPeers = yield* physicalPeers(right);
    const spaces = new Map(), anchors = new Set();
    let tick = 0;
    // A retained multi-terminal library part can witness a net on the same numbered pin.
    // Keep every connected observation. A split or a merge invalidates the
    // correspondence even when both revisions happen to print the same net name.
    for (const a of left) {
      if ((++tick & 63) === 0) yield;
      const exact = pairs.get(a.key), b = exact && targets.get(exact.target);
      if (!b || collisions.has(a) || collisions.has(b) || !a.libraryName || a.libraryName !== b.libraryName ||
          !a.prefix || a.prefix !== b.prefix || netSpace(a) !== netSpace(b) || !sameInstances(a,b)) continue;
      const ap = pins(a), bp = pins(b);
      if (ap.size < 3 || bp.size < 3) continue;
      anchors.add(a); anchors.add(b);
      const k = netSpace(a);
      if (!spaces.has(k)) spaces.set(k, {from: new Map(), to: new Map(), observations: new Map()});
      const {from, to, observations} = spaces.get(k);
      for (const [pin, n] of ap) {
        if (!bp.has(pin)) continue;
        if (!from.has(n)) from.set(n, new Set());
        from.get(n).add(bp.get(pin));
        observations.set(n, (observations.get(n) || 0) + 1);
      }
      for (const [pin, n] of bp) {
        if (!ap.has(pin)) continue;
        if (!to.has(n)) to.set(n, new Set());
        to.get(n).add(ap.get(pin));
      }
    }
    if (!spaces.size && !roles.size && (!oldPeers.size || !newPeers.size)) return;
    // Uniqueness includes the entire revisions, even components already assigned by ID.
    // A repeated circuit must not become "unique" merely because the other copy was taken.
    function *profiles(parts, old, peers) {
      const byPart = new Map(), byCircuit = new Map(), byRating = new Map(), unknownRating = new Set();
      const counts = new Map(), useByPart = new Map(), connectors = [], interfaces = new Map(), signals = new Map(), occupants = new Map();
      for (const p of parts) {
        if ((++tick & 63) === 0) yield;
        const space = netSpace(p), graph = spaces.get(space), nets = pins(p);
        let use = counts.get(space);
        if (!use) counts.set(space, use = new Map());
        useByPart.set(p, use);
        for (const n of new Set(nets.values())) use.set(n, (use.get(n) || 0) + 1);
        if (!p.prefix || nets.size < 2 || !graph && !peers.has(p)) continue;
        const selective = new Map(), terminals = [], named = new Map();
        for (const [number, name] of nets) {
          const observed = (old ? graph?.from : graph?.to)?.get(name);
          let net = ["name", name];
          if (observed) {
            const other = observed.values().next().value;
            const inverse = (old ? graph.to : graph.from).get(other);
            if (other && observed.size === 1 && inverse?.size === 1 && inverse.has(name)) {
              net = ["pin", old ? name : other]; selective.set(net[1], name);
              named.set(number, {name, identity: net[1]});
            } else net = [old ? "before" : "after", name];
          }
          terminals.push([number, JSON.stringify(net)]);
        }
        if (graph && p.domain === "pcb" && peers.has(p)) {
          if (!occupants.has(graph)) occupants.set(graph,new Map());
          const nodes = occupants.get(graph);
          for (const id of selective.keys()) {
            if (!nodes.has(id)) nodes.set(id,[]);
            const owners = nodes.get(id);
            if (owners.length < 3) owners.push(p); // the direct connection below requires exactly two
          }
        }
        // The connector used as the stationary anchor is the other end of these lines.
        if (graph && !anchors.has(p) && /^(?:J|P|CN|CON)$/.test(p.prefix) && peers.has(p)) connectors.push({p, space, graph, selective, use});
        if (nets.size !== p.pinCount || new Set(terminals.map(t => t[1])).size < 2) continue;
        terminals.sort((a,b) => order(a[0],b[0]));
        const numbered = JSON.stringify(terminals);
        const passive = terminals.length === 2 && (p.prefix === "R" || p.prefix === "C");
        const circuit = JSON.stringify([space, p.unit, p.prefix, passive ? terminals.map(t => t[1]).sort() : numbered]);
        const rating = p.rating || peers.get(p)?.rating;
        const rated = rating && JSON.stringify([circuit, rating]);
        const peer = peers.get(p);
        const reversible = !p.polarized && !peer?.polarized && (p.reversible || peer?.reversible);
        const profile = {part: p, circuit, rated, numbered, selective, named, use, reversible};
        byPart.set(p, profile); group(byCircuit, circuit, profile);
        if (rated) group(byRating, rated, profile); else unknownRating.add(circuit);
      }
      // A connector can change package and pad numbering while still exposing the same three
      // or more distinct signals. Exclude buses/rails with many users or many anchor pins.
      for (const {p, space, graph, selective, use} of connectors) {
        const lines = [...selective].filter(([id,n]) => use.get(n) <= 8 && graph.observations.get(id) <= 2).map(([id]) => id).sort();
        signals.set(p,new Set(lines));
        if (lines.length >= 3) group(interfaces, JSON.stringify([space, p.prefix, p.unit, lines]), p);
      }
      return {byPart, byCircuit, byRating, unknownRating, useByPart, interfaces, signals, occupants};
    }
    const before = yield* profiles(left, true, oldPeers), after = yield* profiles(right, false, newPeers);
    const confirmed = [], blocked = new Set(), claimed = new Set(), direct = new Set();
    // A two-device connector net formerly terminated by a resistor can become a direct
    // controller input. Both full pad maps must show the transition at the same retained
    // connector pin. A resistor moved to another sheet could still be deliberately reused.
    for (const [p, profile] of before.byPart) {
      if ((++tick & 63) === 0) yield;
      if (p.domain !== "pcb" || p.prefix !== "R" || p.pinCount !== 2 || pairs.has(p.key) ||
          !oldPeers.has(p) || ![...pins(p).values()].some(n => profile.use.get(n) > 8)) continue;
      const graph = spaces.get(netSpace(p));
      for (const [id,n] of profile.selective) {
        if (profile.use.get(n) !== 2) continue;
        const was = before.occupants.get(graph)?.get(id), now = after.occupants.get(graph)?.get(id);
        if (was?.length !== 2 || now?.length !== 2) continue;
        const port = was.find(part => anchors.has(part) && /^(?:J|P|CN|CON)$/.test(part.prefix));
        const retained = port && pairs.get(port.key), connector = retained?.by === "id" && targets.get(retained.target);
        const nextNet = graph.from.get(n).values().next().value;
        if (connector && now.includes(connector) && after.useByPart.get(connector).get(nextNet) === 2 &&
            now.some(part => /^(?:U|IC)$/.test(newPeers.get(part)?.prefix))) direct.add(p.key);
      }
    }
    for (const [key, as] of before.interfaces) {
      const bs = after.interfaces.get(key);
      if (as.length !== 1 || bs?.length !== 1) continue;
      const a = as[0], b = bs[0];
      if (pairs.has(a.key) || taken.has(b.key) || collisions.has(a) || collisions.has(b) || !sameInstances(a,b)) continue;
      pairs.set(a.key, {target: b.key, by: "topology", confidence: .96, review: false,
        reasons: ["Unique connector exposing the same signals at three or more retained device terminals"]});
      taken.add(b.key); confirmed.push([a,b]);
    }
    for (const [a, old] of before.byPart) {
      if ((++tick & 63) === 0) yield;
      if (pairs.has(a.key) || collisions.has(a) || a.detachedSource) continue;
      const candidates = after.byCircuit.get(old.circuit);
      if (!candidates) continue;
      const peer = oldPeers.get(a), held = peer && pairs.get(peer.key);
      const peerTarget = held?.by === "id" ? targets.get(held.target) : null;
      const linked = peerTarget && !collisions.has(peer) && !collisions.has(peerTarget) ? newPeers.get(peerTarget) : null;
      const linkedProfile = after.byPart.get(linked);
      const linkedRole = linkedProfile?.circuit === old.circuit && opts.designator !== false &&
        a.ref && !/[?*]/.test(a.ref) && a.ref === linked.ref;
      const rated = old.rated && !before.unknownRating.has(old.circuit) && !after.unknownRating.has(old.circuit) &&
        before.byRating.get(old.rated)?.length === 1 && after.byRating.get(old.rated);
      const unique = before.byCircuit.get(old.circuit).length === 1 && candidates.length === 1 || rated?.length === 1;
      if (!linkedRole && !unique) continue;
      const next = linkedRole ? linkedProfile : rated?.length === 1 ? rated[0] : candidates[0], b = next.part;
      if (taken.has(b.key) || collisions.has(b) || b.detachedSource || !sameInstances(a,b)) continue;
      const reversed = old.numbered !== next.numbered;
      if (reversed && !(old.reversible && next.reversible)) continue;
      let local = 0, dedicated = false;
      for (const [id,n] of old.selective) {
        const useA = old.use.get(n), useB = next.use.get(next.selective.get(id));
        if (useA <= 8 && useB <= 8) local++;
        if (useA <= 2 && useB <= 2) dedicated = true;
      }
      const sameRef = opts.designator !== false && a.ref && !/[?*]/.test(a.ref) && a.ref === b.ref;
      const nearby = (p,q) => opts.geometry !== false && !!p?.plane && p.plane === q?.plane && Math.hypot(p.x-q.x,p.y-q.y) <= 2;
      if (linkedRole && reversed && !unique && !local) continue;
      // At least one non-bus terminal must reach a retained device on both revisions. A
      // second observation distinguishes it from a remote copy of the same drawn circuit.
      if (!linkedRole && !(local && (sameRef || linked === b || dedicated || a.value && a.value === b.value ||
          nearby(a,b) || nearby(peer,newPeers.get(b)) || local >= 2))) continue;
      const provenance = a.domain === "pcb" ? "Same designator and retained linked schematic symbol" : "Same designator and retained linked PCB footprint";
      const reasons = [linkedRole ? provenance : "Unique circuit at a numbered pin of a retained component",
        reversed ? "Non-polar terminals exchanged" : "Same numbered terminal connections"];
      if (!linkedRole && rated?.length === 1 && candidates.length > 1) reasons.push("Distinct rated value among the parallel components");
      pairs.set(a.key, {target: b.key, by: "topology", confidence: .96, reasons, review: false});
      taken.add(b.key);
      confirmed.push([a,b]);
    }
    // Carry a proved circuit across representations only when each source-linked pad map
    // independently agrees with its own schematic. A conflicting exact PCB ID stays in place.
    const sameTerminals = (a,b) => {
      const ap = pins(a), bp = pins(b);
      return ap.size >= 2 && ap.size === bp.size && [...ap].every(([pin,n]) => bp.get(pin) === n);
    };
    for (const [a,b] of confirmed) {
      const pa = oldPeers.get(a), pb = newPeers.get(b);
      if (!pa || !pb || pairs.has(pa.key) || collisions.has(pa) || collisions.has(pb) ||
          netSpace(pa) !== netSpace(pb) || !sameInstances(pa,pb) || !sameTerminals(a,pa) || !sameTerminals(b,pb)) continue;
      if (taken.has(pb.key)) { blocked.add(pa.key); claimed.add(pa.key); continue; }
      pairs.set(pa.key, {target: pb.key, by: "topology", confidence: .95, review: false,
        reasons: ["Unique source links to the matched circuit", "Numbered pins and pads agree in each revision"]});
      taken.add(pb.key);
      if ((++tick & 63) === 0) yield;
    }
    for (const [part,peer] of oldPeers) {
      if ((++tick & 63) === 0) yield;
      if (pairs.has(part.key)) continue;
      const old = before.byPart.get(peer), candidates = old && after.byCircuit.get(old.circuit);
      if (candidates?.length && candidates.length <= KEEP && candidates.every(c => {
        const physical = newPeers.get(c.part);
        return physical && taken.has(physical.key) && netSpace(part) === netSpace(physical);
      })) blocked.add(part.key);
    }
    return {before: before.byPart, after: after.byPart, oldUse: before.useByPart, newUse: after.useByPart,
      oldPeers, newPeers, blocked, claimed, direct, roles, oldSignals: before.signals, newSignals: after.signals};
  }
  function *steps(left, right, opts = {}) {
    const pairs = new Map(), taken = new Set(), reviewOwners = new Set(), collisions = new Set(), choices = new Map();
    const pins = pinReader();
    let tick = 0;
    // Mutual uniqueness is essential: a pasted link is evidence to review, never an exact match.
    for (const [field, by] of [["ids", "id"], ["kicadIds","kicad-source"], ["links", "link"], ["sourceIds", "source"]]) {
      if (opts.exact === false) break;
      const index = new Map(), forward = new Map(), reverse = new Map();
      for (const b of right) for (const id of new Set(b[field] || [])) group(index, id, b);
      for (const a of left) {
        const found = new Set();
        for (const id of a[field] || []) for (const b of index.get(id) || []) if (compatible(a, b) &&
            (by !== "kicad-source" || a.domain && a.scope === b.scope)) found.add(b);
        for (const b of found) group(reverse, b, a);
        forward.set(a, [...found]);
        if ((++tick & 255) === 0) yield;
      }
      for (const [a, bs] of forward) {
        if (bs.length === 1 && reverse.get(bs[0]).length === 1 &&
            !(by === "source" && (a.detachedSource || bs[0].detachedSource))) {
          const b = bs[0];
          if (pairs.has(a.key) || taken.has(b.key)) continue;
          pairs.set(a.key, {target: b.key, by, confidence: 1, reasons: [by === "id" ? "Same object ID" : by === "source" ? "Same Altium source ID" :
            by === "kicad-source" ? "Same KiCad source object in this document" : "Same component link"], review: false});
          taken.add(b.key);
        } else if (bs.length) { collisions.add(a); for (const b of bs) collisions.add(b); }
      }
    }
    let restA = left.filter(a => !pairs.has(a.key)), restB = right.filter(b => !taken.has(b.key));
    const reviewSources = new Set(), reviewTargets = new Set();
    if (!restA.length || !restB.length || opts.infer === false) return {pairs, choices, reviewSources, reviewTargets};

    // Infer only one-to-one net renames witnessed at the same numbered pin of exact components.
    // Split/merge evidence and a name surviving on both sides veto a rename. Scope includes the
    // pair of sheets and hierarchy paths, so a local name used elsewhere cannot cast a vote.
    const aliases = new Map(), targets = new Map(right.map(p => [p.key, p]));
    for (const a of left) {
      const pair = pairs.get(a.key);
      if (!pair) continue;
      const b = targets.get(pair.target), k = region(a, b);
      let r = aliases.get(k);
      if (!r) aliases.set(k, r = {from: new Map(), to: new Map(), leftSpace:netSpace(a), rightSpace:netSpace(b)});
      const ap = pins(a), bp = pins(b);
      for (const [pin, n] of ap) {
        const v = bp.get(pin);
        if (!v) continue;
        if (!r.from.has(n)) r.from.set(n, new Set());
        if (!r.to.has(v)) r.to.set(v, new Set());
        r.from.get(n).add(v); r.to.get(v).add(n);
      }
      if ((++tick & 127) === 0) yield;
    }
    const rename = new Map(), oldNames = aliases.size ? namesBySpace(left,pins) : null, newNames = aliases.size ? namesBySpace(right,pins) : null;
    for (const [k, r] of aliases) {
      const map = new Map();
      for (const [n, vs] of r.from) {
        const v = vs.values().next().value;
        if (vs.size === 1 && r.to.get(v).size === 1 && !newNames.get(r.rightSpace).has(n) && !oldNames.get(r.leftSpace).has(v)) map.set(n, v);
      }
      if (map.size) rename.set(k, map);
    }
    let circuits;
    if (pairs.size && opts.topology !== false) {
      circuits = yield* matchCircuits(left, right, pairs, taken, collisions, pins, opts);
      restA = restA.filter(a => !pairs.has(a.key));
      restB = restB.filter(b => !taken.has(b.key));
    }
    // Each part keeps only its KEEP strongest candidates, so memory and the assignment stay linear
    // in the part count (thousands of interchangeable 0402 capacitors on GND would otherwise make
    // millions of edges). Equal scores prefer the candidate at the same rank in its scope, so
    // indistinct copies keep different candidates instead of all keeping the same few.
    const byScope = new Map(), rank = new Map(), rowsByScope = new Map();
    for (const [rows, index] of [[restB,byScope],[restA,rowsByScope]]) for (const p of [...rows].sort((a,b) => order(a.key,b.key))) {
      group(index,p.scope,p); rank.set(p,index.get(p.scope).length-1);
    }
    // Sparse populations retain a full search. For dense scopes, find peers directly by
    // every dimension that can admit an edge: ref, pin/net, circuit witness, material,
    // captured source identity, or nearby placement. Sample only ambiguous, crowded
    // posting lists; a rare named terminal or footprint still has its own independent list.
    const pools = new Map(), crossNames = new Map(), cell = Math.max(2,opts.tolerance || 0);
    for (const map of rename.values()) for (const [name, other] of map) {
      if (!crossNames.has(name)) crossNames.set(name,new Set());
      crossNames.get(name).add(other);
    }
    function keysFor(p, old) {
      const keys = new Set(), put = (...bits) => keys.add(JSON.stringify([p.unit,...bits]));
      if (p.ref && !/[?*]/.test(p.ref)) put("ref",p.ref);
      for (const field of ["links","ids","sourceIds","kicadIds"]) for (const id of p[field] || []) put(field,id);
      if (p.footprint && p.value) for (const lib of [p.library,p.libraryName]) if (lib) put("material",lib,p.footprint,p.value);
      for (const [pin,n] of pins(p)) {
        put("terminal",pin,n);
        if (old) for (const other of crossNames.get(n) || []) put("terminal",pin,other);
      }
      const peer = (old ? circuits?.oldPeers : circuits?.newPeers)?.get(p);
      for (const owner of [p, peer]) {
        if (!owner) continue;
        const circuit = (old ? circuits?.before : circuits?.after)?.get(owner)?.circuit;
        if (circuit) put("circuit",circuit);
        const role = circuits?.roles.get(owner);
        if (role) put("role",role);
      }
      if (opts.geometry !== false && p.plane && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        const x = Math.floor(p.x/cell), y = Math.floor(p.y/cell), reach = old ? 1 : 0;
        for (let i=-reach;i<=reach;i++) for (let j=-reach;j<=reach;j++) put("cell",p.plane,x+i,y+j);
      }
      return keys;
    }
    for (const [scope,list] of byScope) if (list.length > KEEP*8) {
      const index = new Map();
      for (const p of list) {
        for (const k of keysFor(p,false)) group(index,k,p);
        if ((++tick & 63) === 0) yield;
      }
      pools.set(scope,index);
    }
    const work = {scored:0, largestPool:0};
    const forward = new Map(), reverse = new Map(), reused = new Set(), unpairedReasons = new Map();
    for (const a of restA) {
      if (circuits?.claimed.has(a.key)) continue;
      const scoped = byScope.get(a.scope) || [], mine = [];
      const old = circuits?.before.get(a), oldUse = circuits?.oldUse.get(a);
      const peerPart = circuits?.oldPeers.get(a), peer = circuits?.before.get(peerPart);
      const role = circuits?.roles.get(a) || circuits?.roles.get(peerPart);
      const diagonal = rank.get(a) * Math.max(0, scoped.length - 1) / Math.max(1, rowsByScope.get(a.scope).length - 1);
      let pool = scoped, limited = false, independent = null;
      const index = pools.get(a.scope);
      if (index) {
        const found = new Map();
        independent = new Set();
        for (const key of keysFor(a,true)) {
          const list = index.get(key);
          if (!list) continue;
          const mid = Math.round(diagonal * (list.length-1)/Math.max(1,scoped.length-1));
          const start = Math.max(0,Math.min(list.length-KEEP*4,mid-KEEP*2));
          for (let i=start;i<Math.min(list.length,start+KEEP*4);i++) {
            const p = list[i];
            found.set(p,(found.get(p) || 0)+1/list.length);
            if (list.length <= KEEP*4) independent.add(p);
          }
        }
        pool = [...found.keys()];
        if (pool.length > CHUNK) {
          limited = true;
          pool.sort((x,y) => found.get(y)-found.get(x) || order(x.key,y.key));
          pool.length = CHUNK;
        }
      }
      work.largestPool = Math.max(work.largestPool,pool.length);
      for (const b of pool) {
        if ((++tick & 127) === 0) yield;
        if (!compatible(a, b) || a.sheet && b.sheet && a.sheet !== b.sheet && opts.strictSheet) continue;
        work.scored++;
        const alias = rename.size ? rename.get(region(a, b)) : null;
        const shared = collisions.has(a) && collisions.has(b) && ["links","ids","sourceIds","kicadIds"].some(f=>(a[f]||[]).some(id=>(b[f]||[]).includes(id)));
        const next = old && circuits.after.get(b);
        const peerTarget = circuits?.newPeers.get(b), otherPeer = peer && circuits.after.get(peerTarget);
        const peerCircuit = otherPeer && peer.circuit === otherPeer.circuit;
        const sameRole = role && role === (circuits.roles.get(b) || circuits.roles.get(peerTarget));
        const circuit = next && old.circuit === next.circuit;
        if (opts.designator !== false && opts.geometry !== false && circuits?.direct.has(a.key) && a.ref &&
            !/[?*]/.test(a.ref) && a.ref === b.ref && peerTarget && peerPart.scope !== peerTarget.scope &&
            a.libraryName !== b.libraryName && a.footprint !== b.footprint && a.value !== b.value &&
            Math.hypot(a.x-b.x,a.y-b.y) > 2 && !shared && !circuit && !peerCircuit && !sameRole) {
          reused.add(a.key); continue;
        }
        const edge = evidence(a, b, pins(a), pins(b), alias, opts, shared || circuit || peerCircuit || sameRole, oldUse, circuits?.newUse.get(b));
        if (!edge) continue;
        if (limited || independent && !independent.has(b)) {
          edge.uncertain = true; edge.reasons.push("Additional components share this evidence");
        }
        if (sameRole) {
          edge.score += 65; edge.uncertain = true;
          edge.reasons.push("Same terminal function on a proposed component replacement");
        }
        if (peerCircuit && !circuit) {
          edge.score += 48; edge.uncertain = true;
          edge.reasons.push("Source-linked components have the same circuit connections");
        }
        if (circuit && old.numbered !== next.numbered) {
          edge.score += 48; edge.uncertain = true;
          edge.reasons.push(old.reversible && next.reversible ? "Non-polar terminals exchanged" : "Same two nets, verify terminal polarity");
        }
        if (next && !circuit) for (const [pin, previous] of old.named) {
          const current = next.named.get(pin);
          if (current?.name === previous.name && current.identity !== previous.identity) {
            edge.uncertain = true;
            edge.reasons.push("A reused net name reaches a different pin of a retained component");
            break;
          }
        }
        if (collisions.has(a) || collisions.has(b)) {
          edge.uncertain = true; edge.reasons.push("Component link or ID is shared by copies");
        }
        if ((a.channel || b.channel) && a.channel !== b.channel) {
          edge.uncertain = true; edge.reasons.push("Hierarchy path is missing on one side");
        }
        if (!sameInstances(a,b)) {
          edge.uncertain = true; edge.reasons.push("The component appears in different sheet instances");
        }
        // Part numbers and widely shared supply rails survive wholesale redesigns. With two
        // complete two-terminal maps, offer a possible replacement for inspection but give
        // it no assignment weight unless a position, local connection, or physical peer
        // corroborates it. A redrawn component on a different sheet can use the same BOM part.
        const newUse = circuits?.newUse.get(b);
        if (oldUse && newUse && a.pinCount === 2 && b.pinCount === 2 && pins(a).size === 2 && pins(b).size === 2 &&
            !shared && !circuit && !peerCircuit && !sameRole && !edge.near &&
            !(edge.ref && a.libraryName && a.libraryName === b.libraryName && a.footprint && a.footprint === b.footprint && a.value && a.value === b.value) &&
            !(edge.ref && circuits.direct.has(a.key) && peerPart && peerTarget && peerPart.scope === peerTarget.scope) &&
            !(peerPart && peerTarget && peerPart.plane === peerTarget.plane && Math.hypot(peerPart.x-peerTarget.x,peerPart.y-peerTarget.y) <= 2) &&
            ![...pins(a).values()].some(n => [...pins(b).values()].some(m => (m === n || alias?.get(n) === m) &&
              (oldUse.get(n) <= 8 || newUse.get(m) <= 8)))) {
          edge.alternativeOnly = true;
          edge.reasons.push("No independent position or local circuit connection supports this pairing");
        }
        mine.push(edge);
      }
      mine.sort((x, y) => y.score - x.score || Math.abs(rank.get(x.b) - diagonal) - Math.abs(rank.get(y.b) - diagonal) || order(x.b.key, y.b.key));
      if (mine.length > KEEP) mine.length = KEEP;
      for (const edge of mine) { group(forward, a, edge); group(reverse, edge.b, edge); }
    }
    // Disconnected groups have independent optima, so e.g. a lone op-amp never enlarges a
    // matrix of interchangeable resistors. Zero-weight dummy columns allow either side to be new.
    const seen = new Set();
    for (const first of restA) {
      if (seen.has(first) || !forward.has(first)) continue;
      const as = [first], bs = new Set();
      seen.add(first);
      for (let i = 0; i < as.length; i++) for (const e of forward.get(as[i])) {
        if (bs.has(e.b)) continue;
        bs.add(e.b);
        for (const other of reverse.get(e.b)) if (!seen.has(other.a)) { seen.add(other.a); as.push(other.a); }
        if ((++tick & 127) === 0) yield;
      }
      as.sort((x, y) => order(x.key, y.key));
      // A group larger than CHUNK rows is assigned CHUNK rows at a time, rows that want the same
      // candidates together, so the assignment never goes cubic in the board's part count. A row
      // whose best candidate an earlier chunk took loses margin below and goes to review.
      const ordered = as.length > CHUNK ? as.map(a => [rank.get(forward.get(a)[0].b), a]).sort((x, y) => x[0] - y[0] || order(x[1].key, y[1].key)).map(x => x[1]) : as;
      const best = new Map(), used = new Set();
      for (let c = 0; c < ordered.length; c += CHUNK) {
        const rows = ordered.slice(c, c + CHUNK), free = new Set();
        for (const a of rows) for (const e of forward.get(a)) if (!used.has(e.b)) free.add(e.b);
        if (!free.size) continue;
        const columns = [...free].sort((x, y) => order(x.key, y.key));
        const index = new Map(columns.map((b, j) => [b, j + 1]));
        const weights = rows.map(a => new Map(forward.get(a).filter(e => !e.alternativeOnly && index.has(e.b)).map(e => [index.get(e.b), e.score])));
        const matrix = {weights, columns: columns.length};
        const owners = opts.background && rows.length * columns.length >= 4096 ?
          yield matrix : yield* assign(matrix);
        for (let j = 1; j <= columns.length; j++) if (owners[j] && weights[owners[j]-1].has(j)) { best.set(rows[owners[j]-1], columns[j-1]); used.add(columns[j-1]); }
      }
      for (const a of as) {
        const b = best.get(a), edges = forward.get(a);
        const winner = b && edges.find(e => e.b === b);
        if (!winner) continue;
        let margin = Infinity, indistinct = false;
        // Check competition from BOTH sides. When only a printed ref separates otherwise
        // identical components, reannotation and copy/paste cannot be resolved automatically.
        for (const e of [...edges, ...reverse.get(b)]) if (e !== winner && !e.alternativeOnly) {
          margin = Math.min(margin, winner.score - e.score);
          if (winner.ref && !e.ref && winner.score - e.score <= REF_WEIGHT + 2) indistinct = true;
        }
        const review = winner.uncertain || !winner.strong || margin < 12 || indistinct;
        const reasons = [...winner.reasons];
        if (margin < 12 || indistinct) reasons.push("Another component has similar evidence");
        const confidence = review ? Math.max(.3, Math.min(.79, winner.score / 120)) : Math.min(.99, .80 + winner.score / 650);
        pairs.set(a.key, {target: b.key, by: winner.by, confidence: Math.round(confidence * 100) / 100, reasons, review});
        taken.add(b.key);if (review) reviewOwners.add(b.key);
      }
      for (const a of as) {
        const pair = pairs.get(a.key);
        if (pair && !pair.review) continue;
        const candidates = forward.get(a).filter(e => !taken.has(e.b.key) || reviewOwners.has(e.b.key));
        if (!candidates.length) continue;
        if (!pair && candidates.every(e => e.alternativeOnly)) unpairedReasons.set(a.key,"No independent position or local circuit connection supports this pairing");
        choices.set(a.key, candidates.sort((x, y) => y.score - x.score || order(x.b.key, y.b.key)).map(e =>
          e.b.key===pair?.target ? pair : {target:e.b.key, confidence:Math.round(100*Math.max(.3, Math.min(.79, e.score / 120)))/100, reasons:e.reasons}));
        reviewSources.add(a.key);
        for (const e of candidates) reviewTargets.add(e.b.key);
      }
    }
    for (const key of reused) if (!pairs.has(key)) {
      reviewSources.add(key);
      unpairedReasons.set(key,"The connector now connects directly to a controller. Only the designator points to a component on another sheet.");
    }
    for (const key of circuits?.blocked || []) if (!pairs.has(key)) {
      reviewSources.add(key);
      unpairedReasons.set(key,"The electrical counterpart is already matched to another object");
    }
    // A redesigned connector may move between sheets. Show the competing lineage when
    // its matched board footprint still exposes at least two of the same external signals.
    if (circuits) for (const [symbol,foot] of circuits.oldPeers) {
      if ((++tick & 63) === 0) yield;
      if (symbol.domain !== "schematic" || pairs.has(symbol.key)) continue;
      const boardPair = pairs.get(foot.key), destination = boardPair && targets.get(boardPair.target);
      const moved = destination && circuits.newPeers.get(destination);
      if (!moved || moved.scope === symbol.scope || moved.channel !== symbol.channel) continue;
      const signals = circuits.oldSignals.get(foot), other = circuits.newSignals.get(destination);
      if (signals && other && [...signals].filter(s => other.has(s)).length >= 2) {
        reviewSources.add(symbol.key);
        unpairedReasons.set(symbol.key,"A connector on another sheet shares signals with the earlier footprint");
      }
    }
    return {pairs, choices, reviewSources, reviewTargets, unpairedReasons, work};
  }
  const REF_WEIGHT = 23, KEEP = 8, CHUNK = 128;
  function evidence(a, b, ap, bp, alias, opts, shared, oldUse, newUse) {
    const ref = !!a.ref && !/[?*]/.test(a.ref) && a.ref === b.ref && opts.designator !== false;
    const lib = !!a.library && a.library === b.library || !!a.libraryName && a.libraryName === b.libraryName;
    const fp = !!a.footprint && a.footprint === b.footprint, val = !!a.value && a.value === b.value;
    const related = lib || fp || !!a.prefix && a.prefix === b.prefix;
    // Every accepted pairing below needs one of these; skip the pin scan for unrelated parts.
    if (!ref && !related && !shared) return null;
    const d = opts.geometry === false || !a.plane || a.plane !== b.plane || ![a.x,a.y,b.x,b.y].every(Number.isFinite) ? Infinity : Math.hypot(a.x - b.x, a.y - b.y);
    const samePlace = d <= (opts.tolerance ?? .05);
    let equal = 0, renamed = 0, total = ap.size, commonOnly = !!oldUse && !!newUse;
    for (const [number, n] of bp) {
      const prev = ap.get(number);
      if (!prev) total++;
      else if (n === prev || alias?.get(prev) === n) {
        equal++;
        if (n !== prev) renamed++;
        if (!(oldUse?.get(prev) > 8 && newUse?.get(n) > 8)) commonOnly = false;
      }
    }
    if (opts.topology === false && !ref && !samePlace) return null;
    if (!shared && !ref && !(equal && related) && !(samePlace && related) && !(lib && fp && val)) return null;
    // A crowded supply by itself connects many unrelated new parts in a redesign. Retain
    // proposals with an independent clue (including proximity or complete multi-net topology).
    if (!shared && !ref && !fp && !val && a.libraryName !== b.libraryName && d > 2 &&
        commonOnly && a.sourceIds?.length && b.sourceIds?.length &&
        !(equal === total && new Set(ap.values()).size > 1)) return null;
    let score = ref ? REF_WEIGHT : 0;
    const reasons = [];
    if (ref) reasons.push("Same designator");
    if (total) {
      score += Math.round(46 * equal / total);
      if (equal === total && total >= 2) score += 16;
      if (ap.size && bp.size) score -= Math.round(12 * (1 - equal / total));
      reasons.push("Same nets on " + equal + " of " + total + " pins" + (renamed ? " (" + renamed + " after net rename)" : ""));
    }
    if (lib) {score += 17; reasons.push("Same library part");}
    if (fp) {score += 14; reasons.push("Same footprint");}
    if (val) {score += 8; reasons.push("Same value");}
    if (samePlace) {score += 32; reasons.push("Same position");}
    else if (d <= 2) {score += 7; reasons.push("Nearby position");}
    if (a.sheet && a.sheet === b.sheet) {score += 4; reasons.push("Same sheet");}
    if (a.channel && a.channel === b.channel) {score += 5; reasons.push("Same hierarchy path");}
    if (a.room && a.room === b.room) {score += 4; reasons.push("Same room");}
    const consistentPins = equal > 0 && equal >= .75 * total;
    const strong = samePlace && (lib || fp || ref) || consistentPins && (lib || fp || ref && val) ||
      ref && (lib || fp) && (val || lib && fp) && !(ap.size && bp.size && !equal);
    const differentFamily = a.prefix && b.prefix && a.prefix !== b.prefix;
    const uncertain = !lib && (!fp && (!val || !consistentPins) || !val && differentFamily);
    if (uncertain) reasons.push("Library part or package differs");
    return {a, b, score: Math.max(1, score), ref, reasons, strong, uncertain, near:d <= 2,
      by: samePlace && (lib || fp) ? "net-geometry" : ref ? "designator" : equal ? "topology" : "assignment"};
  }
  // Rectangular Hungarian assignment using reduced costs and augmenting paths.
  function *assign({weights, columns}) {
    const n = weights.length, m = columns + n, u = new Float64Array(n + 1), v = new Float64Array(m + 1);
    const owner = new Int32Array(m + 1), previous = new Int32Array(m + 1);
    let tick = 0;
    for (let i = 1; i <= n; i++) {
      owner[0] = i;
      let j0 = 0;
      const slack = new Float64Array(m + 1).fill(Infinity), used = new Uint8Array(m + 1);
      do {
        used[j0] = 1;
        const i0 = owner[j0], row = weights[i0 - 1];
        let delta = Infinity, next = 0;
        for (let j = 1; j <= m; j++) {
          if ((++tick & 2047) === 0) yield;
          if (used[j]) continue;
          const reduced = -(row.get(j) || 0) - u[i0] - v[j];
          if (reduced < slack[j]) {slack[j] = reduced; previous[j] = j0;}
          if (slack[j] < delta) {delta = slack[j]; next = j;}
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) {u[owner[j]] += delta; v[j] -= delta;}
          else slack[j] -= delta;
        }
        j0 = next;
      } while (owner[j0]);
      do {const j = previous[j0]; owner[j0] = owner[j]; j0 = j;} while (j0);
    }
    return owner;
  }
  function finish(iter) {let s; do {s = iter.next();} while (!s.done); return s.value;}
  async function solve(matrix, active) {
    const W = globalThis.AtriumWorkerPool;
    if (W?.canStart()) {
      // Send only numeric edge weights; the worker needs neither the project nor its library.
      const pool = W.get("component-matching", () => assign.toString() + "\n" + finish.toString() +
        "\nself.onmessage=({data})=>self.postMessage({id:data.id,result:finish(assign(data.task))});", {size: 1});
      if (pool.available) {
        const job = pool.run(matrix), watch = setInterval(() => {if (!active()) job.cancel();}, 50);
        try {return await job;} catch (e) {if (!active()) return null; if (e.hung) throw e;}
        finally {clearInterval(watch);}
      }
    }
    return inSlices(assign(matrix), active);
  }
  async function inSlices(iter, active = () => true) {
    let answer;
    while (active()) {
      const end = Date.now() + 6;
      do {
        const s = iter.next(answer); answer = undefined;
        if (s.done) return s.value;
        if (s.value) {answer = await solve(s.value, active); break;}
      } while (Date.now() < end);
      if (active()) await new Promise(r => setTimeout(r, 0));
    }
    return null;
  }
  return {describe, boardPins, boardLocations, steps, finish, inSlices};
})();
