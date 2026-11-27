"use strict";
// The live pour worker holds a mirror at the last sent journal position. A reset seeds the
// mirror in small messages; an ordinary edit sends just the changed rows in board order.
globalThis.AtriumLivePourClient = (() => {
  const ROWS = 64, SLICE_MS = 4, IDLE_MS = 30000, TIMEOUT_MS = 120000;
  const moved = () => Object.assign(Error("The board changed."), {cancelled:true});
  const defer = () => new Promise(resolve => {
    if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(resolve, {timeout:50});
    else setTimeout(resolve, 0);
  });

  function create() {
    let worker, mirror, active, retire, sequence = 0;
    function ask(data, still, drive) {
      return new Promise((resolve, reject) => {
        const span = globalThis.AtriumDiagnostics?.performance?.queue("pours", "request");
        const request = {id:++sequence, resolve, reject, rows:[], runs:new Map(), bytes:0, receive:0, span};
        active = request;
        request.timer = setTimeout(() => close(Object.assign(Error("The live pour worker stopped responding."), {hung:true})), TIMEOUT_MS);
        drive(request.id).then(() => {
          if (active !== request || !still()) throw moved();
          request.span?.start();
          worker.postMessage({...data, id:request.id});
        }).catch(error => {
          if (active !== request) return;
          // An interrupted reset or delta may only have sent part of its data.
          mirror = null;
          finish(request, error);
        });
      });
    }

    function finish(request, error, result) {
      if (active !== request) return;
      active = null; clearTimeout(request.timer);
      if (worker) retire = setTimeout(() => close(), IDLE_MS);
      request.span?.end(error?.cancelled ? "cancelled" : error ? "failed" : "completed");
      if (error) request.reject(error);
      else request.resolve(result);
    }
    function close(error = moved()) {
      clearTimeout(retire);
      worker?.terminate();
      worker = null; mirror = null;
      if (active) finish(active, error);
    }
    function cancel() {
      if (!active) return;
      const request = active;
      // A job that has reached the solve already applied its delta. Incomplete setup
      // never advances the mirror cursor.
      try {worker?.postMessage({type:"cancel", id:request.id});}
      catch {mirror = null;}
      finish(request, moved());
    }
    function open() {
      if (worker) return;
      const opened = AtriumWorkerPool.script("workers/live-pour-worker.js");
      worker = opened;
      const crashed = event => {
        event.preventDefault?.();
        if (worker === opened) close(Error(event.message || "The live pour worker could not start."));
      };
      opened.onerror = crashed;
      opened.onmessageerror = crashed;
      opened.onmessage = ({data}) => {
        const request = active;
        if (worker !== opened || !request || data.id !== request.id) return;
        const t = performance.now();
        // Bytes received for new copper (its data, links and arcs as cloned, and the run tables).
        const weigh = value => typeof value === "string" ? value.length : ArrayBuffer.isView(value) ? value.byteLength :
          Array.isArray(value) ? value.reduce((n, x) => n + (typeof x === "number" ? 8 : weigh(x)), 8) :
          value && typeof value === "object" ? Object.values(value).reduce((n, x) => n + weigh(x), 8) : 8;
        if (data.type === "regions") {
          // Rows: a kept region's index, a region held as runs ({fields, runs: keys}), or a region.
          request.rows.push(...data.rows);
          for (const run of data.runs || []) {request.runs.set(run.id, run); request.bytes += weigh(run);}
          for (const row of data.rows) if (typeof row !== "number") request.bytes += weigh(row);
        } else if (data.type === "regionField") {
          const row = request.rows.at(-1), field = row[data.field];
          if (field == null) row[data.field] = data.value;
          else if (Array.isArray(field)) field.push(...data.value);
          else row[data.field] += data.value;
          request.bytes += weigh(data.value);
        } else if (data.error) {
          mirror = null; finish(request, Error(data.error));
        } else {
          request.span?.ready();
          finish(request, null, {...data.result, rows:request.rows, runs:request.runs, request:request.id, receive:request.receive, bytes:request.bytes});
        }
        request.receive = Math.max(request.receive, performance.now() - t);
      };
    }

    function* batches(type, values, index, stats, ids) {
      let rows = [];
      for (const row of values) {
        const huge = (row.points?.length || 0) > 4096 || (globalThis.AtriumPCBPours?.dataLength?.(row) ?? row.data?.length ?? 0) > 131072 ||
          (row.links?.length || 0) > 4096 || (row.arcs?.length || 0) > 4096;
        if (!huge) rows.push(row);
        if (rows.length && (huge || rows.length === ROWS)) {
          yield {type, index, rows};
          rows = [];
        }
        if (huge) {
          // Long contours and polyline arrays also use bounded clone messages.
          const {points, data, links, arcs, ...small} = row;
          yield {type, index, rows:[small]};
          for (const [field, value, size] of [["points",points,4096], ["data",data,131072], ["links",links,4096], ["arcs",arcs,4096]]) {
            if (value == null) continue;
            if (!value.length) yield {type:"field", field, value};
            else for (let k = 0; k < value.length; k += size) yield {type:"field", field, value:value.slice(k, k+size)};
          }
        }
        if (ids) ids.add(row.id);
        stats.rows++;
      }
      if (rows.length) yield {type, index, rows};
    }
    function* snapshot(project, doc, defs, stats, ids) {
      const {documents, library, ...fields} = project;
      const board = documents.indexOf(doc);
      yield {type:"reset", fields, board};
      for (let index = 0; index < documents.length; index++) {
        const {items, pcbDrawing, ...fields} = documents[index];
        const {pours, ...drawing} = pcbDrawing || {};
        yield {type:"document", index, fields, drawing:pcbDrawing ? drawing : null};
        yield* batches("items", items || [], index, stats, index === board ? ids : null);
        if (pours) {
          if (!pours.length) yield {type:"copper", index, rows:[]};
          else yield* batches("copper", pours, index, stats);
        }
      }
      yield* batches("definitions", defs.values(), null, stats);
    }
    function stableVersions(a, b, doc) {
      if (!a || !b || a.length !== b.length) return false;
      return a.every(([d, v], k) => {
        const [next, x] = b[k];
        return d === next && v && x && v.floor === x.floor && v.outer === x.outer &&
          v.pours === x.pours && v.project === x.project && v.library === x.library &&
          v.parameters === x.parameters && (d === doc || v.items === x.items);
      });
    }
    const versionsFor = (project, journal) => project.documents.map(d => [d, journal?.documentVersions?.(d, project, true)]);

    async function refill(doc, defs, project, journal, known, failed, still) {
      if (!still()) throw moved();
      const start = performance.now();
      open();
      clearTimeout(retire);
      const versions = versionsFor(project, journal), v = versions.find(([d]) => d === doc)?.[1];
      const drawing = doc.pcbDrawing, pours = drawing?.pours, signatures = drawing?.pourSignatures, unverified = globalThis.AtriumPourMarker.read(drawing);
      const previous = mirror, scoped = AtriumPolygonPour._internal.scopedWorkerSnapshot(doc,project);
      const edits = !scoped && v && previous?.doc === doc && previous.project === project && previous.defs === defs &&
        previous.pours === pours && previous.signatures === signatures && previous.unverified === unverified && previous.stamp === doc.sourcePourSignature &&
        stableVersions(previous.versions, versions, doc) &&
        journal.orderedItemChanges?.(doc, previous.seq, id => previous.ids.has(id));
      const setup = performance.now() - start;
      const stats = {mode:edits ? "journal" : scoped ? "scoped-snapshot" : "snapshot", rows:0, messages:0, ms:setup, longest:setup, clone:0};
      const ids = edits ? previous.ids : new Set();
      // Only small journal deltas go in one message. A larger delta can still use the mirror,
      // but each buffer must be posted in its own slice, just like a cold snapshot.
      function* changes() {
        const {change, append} = edits, added = new Set(append.map(row => row.id));
        for (const id of change.ids) {
          if (added.has(id)) continue;
          const row = change.items.get(id);
          if (row) yield* batches("replace", [row], null, stats);
          else yield {type:"remove", key:id};
        }
        yield* batches("append", append, null, stats);
      }
      const messages = edits ? changes() : snapshot(project, doc, defs, stats, ids);
      // Invalidate a partial mirror until every message has been sent.
      mirror = null;
      const result = await ask({type:"refill", known:[...known], failed, incremental:!!edits,
        variant:globalThis.AtriumEngine?.variant, length:!!globalThis.AtriumLength}, still, async id => {
        let item;
        do {
          if (!still() || active?.id !== id) throw moved();
          const start = performance.now();
          do {
            item = messages.next();
            if (item.done) break;
            const before = performance.now();
            worker.postMessage(item.value);
            stats.clone = Math.max(stats.clone, performance.now() - before);
            stats.messages++;
          } while (performance.now() - start < SLICE_MS);
          const elapsed = performance.now() - start;
          stats.ms += elapsed;
          stats.longest = Math.max(stats.longest, elapsed);
          if (!item.done) await defer();
        } while (!item.done);
        if (edits) {
          for (const id of edits.change.ids) if (!edits.change.items.has(id)) ids.delete(id);
          for (const row of edits.append) ids.add(row.id);
        }
        mirror = {doc,defs,project,ids,versions,seq:v?.seq,pours,signatures,unverified,stamp:doc.sourcePourSignature};
      });
      return {...result, transport:{...stats, receive:result.receive}};
    }
    function accept({request}, doc, defs, project, journal) {
      if (!mirror || mirror.doc !== doc || !worker) return;
      worker.postMessage({type:"accept", id:request});
      const versions = versionsFor(project, journal);
      Object.assign(mirror, {versions,seq:versions.find(([d]) => d === doc)?.[1]?.seq,defs,
        pours:doc.pcbDrawing?.pours,signatures:doc.pcbDrawing?.pourSignatures,unverified:globalThis.AtriumPourMarker.read(doc.pcbDrawing),stamp:doc.sourcePourSignature});
    }
    return {refill, accept, cancel, close};
  }
  return Object.freeze({create});
})();
