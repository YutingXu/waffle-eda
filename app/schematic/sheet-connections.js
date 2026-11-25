"use strict";

// A projection of the compiler's actual unions. Names alone are never sufficient
// to establish connectivity. Keep instance identities for repeated sheet symbols.
globalThis.AtriumSheetConnections = (() => {
  const H = globalThis.AtriumHierarchy, S = globalThis.AtriumSchObjects;
  const indexes = new WeakMap();
  const labels = {port:"Port", offsheet:"Off-sheet connector", entry:"Sheet entry", label:"Net label", power:"Power port"};
  function direction(obj) {return obj.io === "bidi" ? "bidirectional" : obj.io || "unspecified";}
  const key = (item, entry) => JSON.stringify([item, entry ?? null]);
  function add(map, k, value) {
    const list = map.get(k);
    if (list) list.push(value); else map.set(k, [value]);
  }
  function members(t) {
    return S.busMembers(t.kind === "entry" ? S.repeatEntry(t.name) || t.name : t.name);
  }
  function pair(a, b, scope) {
    if (a.kind === "port" && b.kind === "entry") return pair(b, a, scope);
    if (a.kind === "entry" && b.kind === "port") {
      if (scope === "flat" || b.instance.parent !== a.instance || b.instance.symbol !== a.item) return false;
      const other = new Set(members(b));
      return members(a).some(m => other.has(m));
    }
    if (a.kind !== b.kind || a.name !== b.name) return false;
    if (a.kind === "port") return scope !== "hierarchical";
    if (a.kind === "offsheet") return scope !== "hierarchical" || a.instance.parent === b.instance.parent;
    return a.kind === "label" || a.kind === "power";
  }
  function ignoredText(source, t, scope) {
    const what = labels[t.kind].toLowerCase();
    let why;
    if (source.kind === "port" && t.kind !== "entry" && scope === "hierarchical")
      why = "hierarchical scope connects ports only to sheet entries";
    else if (source.kind === "label" && t.kind === "label" && scope !== "global")
      why = scope + " scope keeps net labels on their sheet";
    else if (source.kind === "offsheet" && t.kind === "offsheet" && scope === "hierarchical")
      why = "hierarchical scope connects off-sheet connectors only on sibling sheets";
    else if ((source.kind === "entry" || t.kind === "entry") && scope === "flat")
      why = "flat scope ignores sheet entries";
    else if (scope === "hierarchical" && (source.kind === "entry" || t.kind === "entry"))
      why = "hierarchical scope pairs a sheet entry with a port on its own child sheet";
    else if (scope === "hierarchical") why = "hierarchical scope does not join these objects by name";
    else return "";
    const where = t.kind === "entry" ? t.doc.name + " on " + t.item.name : t.doc.name;
    return (what === "off-sheet connector" ? "An " : "A ") + what + " named " + t.name + " exists on " + where + ", but " + why + ".";
  }

  // Yield in batches so the editor can publish a large index between paint frames.
  // Explicit synchronous consumers (e.g. an opened overview) use index().
  function* stages(compiled) {
    if (indexes.has(compiled)) return indexes.get(compiled);
    const targets = [], nets = new Map(), byName = new Map(), byDoc = new Map(), byInstance = new Map();
    let work = 0;
    for (const instance of compiled.instances) {
      const doc = instance.doc, items = new Map();
      byInstance.set(instance, items);
      if (!byDoc.has(doc.id)) byDoc.set(doc.id, new Map());
      function register(item, entry, kind) {
        const name = entry?.name ?? item.text;
        const t = {doc, item, entry, kind, name, io:direction(entry || item), instance, keys:[]};
        targets.push(t); items.set(entry || item, t);
        add(byDoc.get(doc.id), key(item.id, entry?.id), t);
        const matchName=kind === "entry" ? S.repeatEntry(name) || name : name;
        let examples=byName.get(matchName);
        if (!examples) byName.set(matchName, examples=new Map());
        const exampleKey=JSON.stringify([doc.id,kind,entry ? item.id : null]);
        if (!examples.has(exampleKey)) examples.set(exampleKey,t);
      }
      for (const item of doc.items) {
        if (++work % 128 === 0) yield;
        if (item.kind === "sheetsymbol") for (const e of item.entries || []) {register(item, e, "entry"); if (++work % 128 === 0) yield;}
        else {const kind = H.sourceType(item); if (kind) register(item, null, kind);}
      }
    }
    function link(t, k) {if (t) {t.keys.push(k); add(nets, k, t);}}
    const named = new Map();
    for (const n of compiled.nets) {
      named.set(n.name, n.key);
      for (const {inst, net} of n.local) {
        const items = byInstance.get(inst);
        for (const s of net.sources) {link(items.get(s.item), n.key); if (++work % 128 === 0) yield;}
        for (const e of net.entries) {link(items.get(e.entry), n.key); if (++work % 128 === 0) yield;}
      }
    }
    for (const b of compiled.busLinks) {
      const t = byInstance.get(b.inst).get(b.entry || b.item);
      for (const k of b.keys) {link(t, k); if (++work % 128 === 0) yield;}
    }

    const powerSheets = new Map();
    for (const t of targets) if (t.kind === "power") for (const k of t.keys) {
      if (powerSheets.has(k)) continue;
      const counts = new Map();
      for (const dest of nets.get(k)) {
        const sheet=counts.get(dest.doc.id);
        if (sheet) sheet.count++; else counts.set(dest.doc.id,{count:1,first:dest});
        if (++work % 128 === 0) yield;
      }
      powerSheets.set(k,counts);
    }
    function targetsFor(docId, itemId, entryId, instanceId, limit) {
      let sources = byDoc.get(docId)?.get(key(itemId, entryId));
      if (instanceId) sources = sources?.filter(t => t.instance.id === instanceId);
      if (!sources?.length) return null;
      const source = sources[0], own = new Set(sources), connected = new Set(), direct = new Set(), sheets = new Set();
      // Count a common rail from its compiled bucket and read only the visible
      // rows. Repeated instances of the selected source are excluded together.
      const k=source.keys[0];
      if (source.kind==="power" && limit>0 && k && sources.every(s=>s.keys.length===1 && s.keys[0]===k)) {
        const list=nets.get(k), counts=powerSheets.get(k), sample=[];
        for (const [sheet,value] of counts) if (sheet!==docId) {sample.push(value.first); if (sample.length===limit) break;}
        if (sample.length<limit) for (const t of list) if (!own.has(t) && !sample.includes(t)) {sample.push(t); if (sample.length>=limit) break;}
        const sheetCount=counts.size-(counts.get(docId).count===own.size ? 1 : 0);
        return {source,targets:sample,direct:sample.filter(t=>pair(source,t,compiled.effective)),ignored:[],
          count:list.length-own.size,sheets:sheetCount,otherSheet:counts.size>1};
      }
      for (const a of sources) for (const k of a.keys) for (const b of nets.get(k)) {
        if (own.has(b)) continue;
        connected.add(b); sheets.add(b.doc.id);
        if (pair(a, b, compiled.effective)) direct.add(b);
      }
      let choices = [...direct];
      if (source.kind === "port" && choices.some(t => t.kind === "entry")) choices = choices.filter(t => t.kind === "entry");
      const ignored = new Set(), otherSheet = sheets.size > 1 || sheets.size === 1 && !sheets.has(docId);
      if (!otherSheet) for (const t of byName.get(S.repeatEntry(source.name) || source.name)?.values() || []) {
        if (t.doc.id === docId || connected.has(t)) continue;
        const msg = ignoredText(source, t, compiled.effective);
        if (msg) ignored.add(msg);
      }
      const remoteFirst=rows=>rows.filter(t=>t.doc.id!==docId).concat(rows.filter(t=>t.doc.id===docId));
      return {source, targets:remoteFirst([...connected]), direct:remoteFirst(choices), ignored:[...ignored], count:connected.size, sheets:sheets.size, otherSheet};
    }
    const result = {compiled, targets, nets, targetsFor, connectionsFor:name => nets.get(named.get(name)) || []};
    indexes.set(compiled, result);
    return result;
  }
  function index(compiled) {
    const it = stages(compiled);
    let step = it.next();
    while (!step.done) step = it.next();
    return step.value;
  }
  return {labels, direction, stages, index};
})();
