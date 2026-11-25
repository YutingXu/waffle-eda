"use strict";
// A dedicated, ordered board mirror. The editor acknowledges a fill only after its revision
// has been checked and committed. A dropped reply can never become the next job's stored copper.
(() => {
  const G = globalThis, queue = [], cancelled = new Set();
  let project, board, defs, positions, area, pending, lastRow, mirrorSignatures, busy = false, running = 0, ready = false, engineTried = false;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  function load() {
    if (ready) return;
    importScripts("../translator-worker-modules.js");
    importScripts(...G.AtriumTranslatorWorkerModules["polygon-pour"].map(path => "../" + path));
    ready = true;
  }
  function reset(message) {
    project = {...message.fields, documents:[], library:[]};
    board = message.board; defs = new Map(); positions = null; pending = null; mirrorSignatures = null;
    area = {sessions:new Map(), dirtyBoxes:[], changedItems:new Set()};
  }
  function bounds(row) {
    if (!row || !area.changedItems) return;
    const b = G.AtriumPolygonPour._internal.itemBox(row, defs);
    if (b.every(Number.isFinite)) area.dirtyBoxes.push(b);
    // Unknown or global bounds always use the full solve.
    else area.dirtyBoxes = null;
  }
  function edited(old, row) {
    if (!area.changedItems) return;
    if (old) area.changedItems.add(old.id);
    if (row) area.changedItems.add(row.id);
    if (area.dirtyBoxes) { bounds(old); if (area.dirtyBoxes) bounds(row); }
  }
  function index(items) {
    if (!positions) positions = new Map(items.map((row, i) => [row.id, i]));
    return positions;
  }
  function patch(message) {
    const {type, rows} = message, items = project.documents[board].items, byId = index(items);
    if (type === "remove") {
      const pos = byId.get(message.key);
      if (pos != null) {
        edited(items[pos]);
        items.splice(pos, 1);
        positions = null;
      }
      return;
    }
    for (const row of rows) {
      const pos = byId.get(row.id);
      if (type === "append") {
        edited(null, row);
        byId.set(row.id, items.length); items.push(row);
      } else if (pos != null) {
        edited(items[pos], row);
        items[pos] = row;
      } else throw Error("The live pour mirror lost its item order.");
      lastRow = row;
    }
  }
  async function refill(message) {
    const {id, known, failed, incremental, variant, length} = message;
    // Mirror the optional measurement services available to Repour All in the
    // editor. Opened rule libraries already load the shared query compiler.
    if (length && !G.AtriumLength) importScripts("../pcb/length-tuning.js");
    if (!engineTried && (variant === "mvp" || variant === "simd128")) {
      engineTried = true;
      try {
        importScripts("../engine-core.js", "../engine-" + variant + ".js");
        G.AtriumEngine.activate(variant);
      } catch { /* the JS core has identical geometry */ }
    }
    const doc = project.documents[board], P = G.AtriumPolygonPour;
    G.AtriumSignals?.attach?.(project);
    if (!incremental || !area.dirtyBoxes) {area.sessions.clear();area.dirtyBoxes = null;area.changedItems = null;}
    const useArea = {...area};
    // A cancelled solve still advances the mirror's items. An incomplete area solve cannot
    // establish which sessions were updated, so the next job must use a full solve.
    area.dirtyBoxes = []; area.changedItems = new Set(); pending = null;
    const g = P._internal.liveWorkerSteps(doc, defs, {project, known, failed, area:useArea,
      mirrorSignatures:mirrorSignatures ??= new WeakMap()});
    let r = g.next();
    while (!r.done) {
      const t = performance.now();
      do {
        if (r.value?.task) {
          let solved;
          try { solved = P._internal.core.solve(r.value.task); }
          catch (error) {r = g.throw(error);continue;}
          r = g.next(solved);
        } else r = g.next();
      } while (!r.done && performance.now()-t < 8);
      await pause();
      if (cancelled.has(id)) {area.sessions.clear();return;}
    }
    await pause();
    if (cancelled.has(id)) {area.sessions.clear();return;}
    const {drawing, ...result} = r.value;
    if (drawing) {
      const previous = new Map((doc.pcbDrawing?.pours || []).map((region, k) => [region, k]));
      const {pours} = drawing, rows = [];
      let weight = 0;
      pending = {id, drawing, stamp:result.stamp};
      result.drawing = {};
      for (const key of ["importedPourSignature", "sourceHatchSignature", "pourSignatures", "pourSignatureVersion"])
        if (Object.hasOwn(drawing, key)) result.drawing[key] = drawing[key];
      result.hasPours = !!pours;
      for (const region of pours || []) {
        const retained = previous.get(region);
        const size = retained != null ? 16 : (region.data?.length || 0) + (region.links?.length || 0) * 32 + (region.arcs?.length || 0) * 8;
        if (rows.length && (rows.length >= 64 || weight + size > 131072)) {
          G.postMessage({type:"regions", id, rows:rows.splice(0)}); weight = 0;
        }
        if (size <= 131072) {rows.push(retained ?? region);weight += size;continue;}
        const {data, links, arcs, ...small} = region;
        G.postMessage({type:"regions", id, rows:[small]});
        for (const [field, value, step] of [["data",data,131072], ["links",links,4096], ["arcs",arcs,4096]]) {
          if (value == null) continue;
          if (!value.length) G.postMessage({type:"regionField",id,field,value});
          else for (let k = 0; k < value.length; k += step)
            G.postMessage({type:"regionField",id,field,value:value.slice(k,k+step)});
        }
      }
      if (rows.length) G.postMessage({type:"regions", id, rows});
    }
    G.postMessage({type:"result", id, result});
  }

  async function run() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const m = queue.shift();
      try {
        load();
        if (m.type === "reset") reset(m);
        else if (m.type === "document") {
          const {fields, drawing} = m;
          project.documents[m.index] = {...fields, items:[], ...(drawing ? {pcbDrawing:drawing} : {})};
        } else if (m.type === "items" || m.type === "copper") {
          const d = project.documents[m.index];
          const rows = m.type === "items" ? d.items : (d.pcbDrawing.pours ??= []);
          rows.push(...m.rows); lastRow = rows[rows.length-1];
        } else if (m.type === "definitions") {
          mirrorSignatures = null; // Footprint geometry also contributes to a part's signature.
          for (const row of m.rows) { defs.set(row.id, row); project.library.push(row); }
          lastRow = m.rows.at(-1);
        } else if (m.type === "field") {
          // Sliced data is the one path that appends to a row already in the mirror.
          mirrorSignatures = null;
          const p = lastRow[m.field];
          if (p == null) lastRow[m.field] = m.value;
          else if (Array.isArray(p)) p.push(...m.value);
          else lastRow[m.field] += m.value;
          if (area?.changedItems?.size) area.dirtyBoxes = null; // Split rows finish after the delta is applied.
        } else if (m.type === "append" || m.type === "remove" || m.type === "replace") patch(m);
        else if (m.type === "refill") {
          running = m.id;
          if (!cancelled.has(m.id)) await refill(m);
          else {area.sessions.clear();area.dirtyBoxes = null;}
          running = 0;
          cancelled.delete(m.id);
        } else if (m.type === "accept" && pending?.id === m.id) {
          const d = project.documents[board];
          d.pcbDrawing = pending.drawing;
          if (pending.stamp) d.sourcePourSignature = pending.stamp;
          else delete d.sourcePourSignature;
          pending = null;
        }
      } catch (error) {
        // A malformed setup message fails the worker itself. A failure while solving is
        // associated with this request, so the editor can recover with its fallback.
        if (!m.id) {setTimeout(() => {throw error;}, 0);break;}
        area?.sessions.clear(); cancelled.delete(m.id); running = 0;
        G.postMessage({type:"result", id:m.id, error:String(error?.message || error)});
      }
    }
    busy = false;
  }
  G.onmessage = ({data}) => {
    if (data.type === "cancel") {
      if (running === data.id || queue.some(m => m.id === data.id && m.type === "refill")) cancelled.add(data.id);
    } else {queue.push(data);run();}
  };
})();
