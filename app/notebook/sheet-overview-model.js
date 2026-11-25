"use strict";
// Project > Sheet Overview. The diagram uses the compiler's instances and electrical groups.
globalThis.AtriumSheetOverviewModel = (() => {
  const width = 184, height = 74, column = 314, row = 138, pad = 36;

  function sheets(compiled) {
    const nodes = [], byInstance = new Map(), byParent = new Map();
    for (const inst of compiled.instances) {
      const parent = inst.parent ? byInstance.get(inst.parent.id) : null;
      const siblings = byParent.get(parent) ?? new Map();
      byParent.set(parent, siblings);
      // Each symbol is a separate occurrence. Consecutive channel instances of that
      // symbol share a box, including their copies of each nested child symbol.
      const key = inst.symbol?.id ?? inst.doc.id;
      let node = siblings.get(key);
      if (!node) {
        node = {order:nodes.length, doc:inst.doc, parent, children:[], instances:[]};
        siblings.set(key, node);
        nodes.push(node);
        parent?.children.push(node);
      }
      node.instances.push(inst);
      byInstance.set(inst.id, node);
    }
    return {nodes, byInstance};
  }

  function links(compiled, nets, byInstance) {
    const named = new Map(compiled.nets.map(n => [n.key, n])), links = new Map();
    const isBus = globalThis.AtriumSchObjects.isBus;
    const priority = {entry:0, port:1, offsheet:2, label:3, power:4, wire:5};
    const better = (target, old) => !old || (priority[target.kind] ?? 6) < (priority[old.kind] ?? 6);
    function connect(netKey, targets, net) {
      const touches = new Map();
      function add(target) {
        const node = byInstance.get(target.instance.id);
        if (!node) return;
        let touch = touches.get(node);
        if (!touch) touches.set(node, touch = {node});
        if (better(target, touch.target)) touch.target = target;
        if (target.kind !== "wire" && isBus(target.name) && better(target, touch.bus)) touch.bus = target;
      }
      for (const target of targets) add(target);
      // The compiler can join explicitly named wires, even if a sheet has no
      // port or net label to use as a navigation target.
      for (const {inst, net:local} of net?.local || []) {
        const item = local.wires[0];
        if (item && !touches.has(byInstance.get(inst.id))) add({doc:inst.doc, instance:inst, item, kind:"wire", name:net.name});
      }
      if (touches.size < 2) return;
      const ordered = [...touches.values()].sort((a,b) => a.node.order - b.node.order);
      // A net over N sheets needs only N−1 wires. Prefer an actual parent on that
      // net, then fan out from its earliest sheet for unrelated branches or roots.
      for (const destination of ordered.slice(1)) {
        const origin = touches.get(destination.node.parent) ?? ordered[0];
        const from = origin.node, to = destination.node;
        const bus = origin.bus && destination.bus;
        const a = bus ? origin.bus : origin.target, b = bus ? destination.bus : destination.target;
        const name = bus ? (a.name === b.name ? a.name : a.name + " / " + b.name) : net?.name || b.name;
        const pair = from.order + "/" + to.order;
        const key = JSON.stringify([pair, bus ? [a.name,b.name] : netKey]);
        let link = links.get(key);
        if (!link) links.set(key, link = {pair, name, from, to, a, b, nets:new Set(), bus:!!bus});
        if (net) link.nets.add(net.name);
      }
    }
    for (const [key, targets] of nets) connect(key, targets, named.get(key));
    for (const [key, net] of named) if (!nets.has(key) && net.local.length > 1) connect(key, [], net);
    return [...links.values()].sort((a,b) => a.name.localeCompare(b.name) || a.from.order - b.from.order || a.to.order - b.to.order);
  }

  function position(nodes) {
    const hierarchical = nodes.some(n => n.parent);
    let leaves = 0, right = width, bottom = height;
    for (const n of nodes) {
      n.x = pad + (hierarchical ? n.instances[0].depth : n.order % 2) * column;
      if (!hierarchical) n.y = pad + Math.floor(n.order / 2) * row;
      else if (!n.children.length) n.y = pad + leaves++ * row;
      right = Math.max(right, n.x + width);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.children.length) n.y = (n.children[0].y + n.children.at(-1).y) / 2;
      bottom = Math.max(bottom, n.y + height);
    }
    return {width:right + (nodes.length > 2 ? column - width : pad), height:bottom + pad, hierarchical};
  }

  function build(compiled, nets) {
    const {nodes, byInstance} = sheets(compiled);
    return {...position(nodes), nodes, links:links(compiled, nets, byInstance),
      sheetCount:new Set(nodes.map(n => n.doc.id)).size};
  }

  function wire(from, to, offset = 0, structural = false, lane = 0) {
    const baseline = height / 2 + offset - (structural ? 13 : 0);
    const y1 = from.y + baseline, y2 = to.y + baseline;
    const sameColumn = from.x === to.x, facingRight = from.x <= to.x;
    const x1 = from.x + (facingRight ? width : 0);
    const x2 = to.x + (sameColumn || !facingRight ? width : 0);
    // Use the gutter beside the first sheet, even when a connection crosses
    // multiple hierarchy columns, so labels stay between sheet boxes.
    const gutter = (column - width) / 2 * (facingRight ? 1 : -1);
    const x = x1 + gutter + (structural ? -20 : lane);
    if (Math.abs(to.x - from.x) > column) {
      const rail = pad / 2 + offset / 3, bend = x2 - gutter;
      return {d:`M${x1} ${y1}H${x}V${rail}H${bend}V${y2}H${x2}`, x, y:(y1+rail)/2, y1, y2:rail};
    }
    return {d:`M${x1} ${y1}H${x}V${y2}H${x2}`, x, y:(y1+y2)/2, y1, y2};
  }

  function adjacent(nodes, node, key) {
    if (key === "Home") return nodes[0];
    if (key === "End") return nodes.at(-1);
    if (key === "ArrowLeft" && node.parent) return node.parent;
    if (key === "ArrowRight" && node.children.length) return node.children[0];
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
    let best, bestDistance = Infinity;
    for (const other of nodes) {
      const dx = other.x - node.x, dy = other.y - node.y;
      const along = (horizontal ? dx : dy) * sign, across = horizontal ? dy : dx;
      const distance = along + Math.abs(across) * 2;
      if (along > 0 && distance < bestDistance) {best = other; bestDistance = distance;}
    }
    return best;
  }

  return Object.freeze({build, wire, adjacent, width, height});
})();
