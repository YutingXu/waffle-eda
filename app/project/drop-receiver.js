"use strict";

// Common metadata, consent and byte limits for ordinary editor/native drop adapters.
// A receipt is a scoped in-memory object. A path, URL or renderer-supplied string
// never acts as permission to read a local file.
globalThis.AtriumDrop = (() => {
  const MiB = 1024 ** 2, maxFiles = 32, maxBatch = 256 * MiB;
  const limits = Object.freeze({design:maxBatch, library:16 * MiB, image:128 * MiB,
    pdf:128 * MiB, step:32 * MiB, csv:65536});
  const fileKinds = new Map();
  function files(kind, entries) {
    for (const [extension, mime] of entries) fileKinds.set(extension, {kind, mime});
  }
  files("design", ["waffle","wpcb","wsch","wdraw","wpanel","prjpcb","pcbdoc","schdoc",
    "kicad_pro","kicad_pcb","kicad_sch","zip"].map(extension => [extension, "application/octet-stream"]));
  files("library", ["wlib","atrlib","schlib","pcblib","kicad_sym","kicad_mod"].map(extension => [extension, "application/octet-stream"]));
  files("image", [["png","image/png"], ["jpg","image/jpeg"], ["jpeg","image/jpeg"], ["webp","image/webp"],
    ["heic","image/heic"], ["heif","image/heif"], ["svg","image/svg+xml"]]);
  files("pdf", [["pdf","application/pdf"]]);
  files("step", [["step","model/step"], ["stp","model/step"]]);
  files("csv", [["csv","text/csv"]]);

  const routes = {
    "open-design": {targets:["workspace"], kinds:["design","library"]},
    "insert-image": {targets:["sheet"], kinds:["image"]},
    "insert-pdf": {targets:["sheet"], kinds:["pdf"]},
    "open-pdf": {targets:["reader"], kinds:["pdf"]},
    "place-library": {targets:["sheet","board"], kinds:["library","library-part","symbol","footprint","bom-row"]},
    "attach-model": {targets:["part"], kinds:["step"]},
    "import-table": {targets:["table"], kinds:["csv"]},
    "scope-rule": {targets:["rule"], kinds:["net"]},
    "bind-calculation": {targets:["calculation"], kinds:["part"]},
    "resolve-result": {targets:["sheet","board"], kinds:["navigator-result","search-result","object-link"]},
    "paste-entry": {targets:["sheet","board","drawing","panel"], kinds:["clipboard-entry"]},
    "transfer-tab": {targets:["window","tab-strip","tab"], kinds:["tab"]},
    "export-selection": {targets:["external"], kinds:["selection"]},
    "export-frame": {targets:["external"], kinds:["frame"]},
    "export-bom": {targets:["external"], kinds:["bom"]}
  };
  for (const route of Object.values(routes)) {
    Object.freeze(route.targets);
    Object.freeze(route.kinds);
    Object.freeze(route);
  }
  Object.freeze(routes);

  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const controls = /[\u0000-\u001f\u007f]/u;
  const encoder = new TextEncoder();
  const approved = new WeakMap();
  const suffix = name => name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

  function fileMetadata(entry, allowUnknownSize=false) {
    const {name, size} = entry || {};
    if (typeof name !== "string" || !name || name.length > 255 || encoder.encode(name).length > 255 ||
        /[\\/:]/.test(name) || controls.test(name))
      fail("invalid_name", "Choose a regular file with a safe name.");
    const rule = fileKinds.get(suffix(name));
    if (!rule) fail("unsupported_type", "Waffle cannot accept that type of file here.");
    if (!(allowUnknownSize && size == null) && (!Number.isSafeInteger(size) || size <= 0 || size > limits[rule.kind]))
      fail("resource_limit", "The selected file exceeds the drop size limit.");
    const mime = entry.mime ?? entry.type ?? "";
    if (typeof mime !== "string" || mime.length > 127 || controls.test(mime))
      fail("invalid_payload", "The selected file has an invalid media type.");
    const declared = mime.toLowerCase();
    if (rule.kind === "pdf" && declared && declared !== rule.mime && declared !== "application/octet-stream")
      fail("invalid_payload", "The PDF name and declared type do not match.");
    return {name, size:size ?? null, ...rule};
  }

  function active(signal, current) {
    if (signal?.aborted) fail("cancelled", "The drop was cancelled.");
    if (current && !current()) fail("stale_target", "The drop target is no longer active.");
  }

  async function readBytes(entry, {signal, current, load} = {}) {
    const metadata = fileMetadata(entry,!!load);
    const {size} = metadata;
    active(signal,current);
    let bytes;
    if (load) {
      bytes = await load(signal);
      active(signal,current);
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > limits[metadata.kind] ||
          size !== null && bytes.length !== size)
        fail("invalid_payload", "The selected file changed while opening.");
    } else if (entry.bytes instanceof Uint8Array) {
      if (entry.bytes.length !== size) fail("invalid_payload", "The selected file changed while opening.");
      bytes = new Uint8Array(entry.bytes);
    } else if (typeof entry.stream === "function") {
      // Allocate at the approved size and stop at the first oversized chunk.
      bytes = new Uint8Array(size);
      const reader = entry.stream().getReader();
      let offset = 0, complete = false;
      const stop = () => { void reader.cancel().catch(() => {}); };
      signal?.addEventListener("abort", stop, {once:true});
      try {
        while (true) {
          active(signal,current);
          const {done, value} = await reader.read();
          active(signal,current);
          if (done) break;
          if (!(value instanceof Uint8Array) || value.length > size - offset)
            fail("invalid_payload", "The selected file changed while opening.");
          bytes.set(value, offset);
          offset += value.length;
        }
        if (offset !== size) fail("invalid_payload", "The selected file changed while opening.");
        complete = true;
      } finally {
        signal?.removeEventListener("abort", stop);
        if (!complete) stop();
        reader.releaseLock();
      }
    } else {
      fail("ungranted_source", "The source did not provide a selected file.");
    }
    const pdfOffset = bytes[0]===239 && bytes[1]===187 && bytes[2]===191 ? 3 : 0;
    if (metadata.kind === "pdf" && (bytes.length < pdfOffset+8 ||
        ![37,80,68,70,45].every((value, index) => bytes[pdfOffset+index] === value)))
      fail("invalid_payload", "The selected file is not a PDF.");
    active(signal,current);
    return {...metadata, size:bytes.length, bytes};
  }

  function consumeMedia(input, file) {
    const row = approved.get(input);
    if (!row || row.file !== file || row.signal.aborted || !row.current() || !["image","pdf"].includes(input.kind))
      fail("ungranted_source", "Choose, paste or drop an image first.");
    approved.delete(input);
    return input.bytes;
  }

  function identifier(value, name) {
    if (typeof value !== "string" || !value || value.length > 1024 || controls.test(value))
      fail("invalid_payload", name + " is missing or invalid.");
    return value;
  }

  function routeFor(target, kinds) {
    if (!object(target) || typeof target.kind !== "string" || !Array.isArray(kinds) || !kinds.length)
      fail("invalid_target", "Choose a drop target first.");
    return Object.keys(routes).find(key => {
      const route = routes[key];
      return route.targets.includes(target.kind) && kinds.every(kind => route.kinds.includes(kind));
    }) ?? null;
  }

  function describe(source, target, allowUnknownSize=false) {
    if (!object(source) || !object(target)) fail("invalid_payload", "Choose a source and destination.");
    let metadata, reference;
    if (Array.isArray(source.files)) {
      if (!source.files.length || source.files.length > maxFiles)
        fail("resource_limit", "Too many files were selected for one drop.");
      metadata = source.files.map(file=>fileMetadata(file,allowUnknownSize));
      if (metadata.reduce((sum, file) => sum + file.size, 0) > maxBatch)
        fail("resource_limit", "The selected files exceed the combined drop limit.");
    } else {
      const kind = identifier(source.kind, "Source kind"), id = identifier(source.id, "Source object");
      if (Object.hasOwn(limits,kind)) fail("ungranted_source", "Choose the source as a file.");
      reference = {kind,id};
      for (const key of ["projectId","documentId","instanceId","ownerId"]) {
        if (source[key] != null) reference[key] = identifier(source[key], key);
      }
    }
    const destination = {kind:identifier(target.kind, "Target kind")};
    if (target.id != null) destination.id = identifier(target.id, "Target object");
    if (target.point != null) {
      if (!Array.isArray(target.point) || target.point.length !== 2 || !target.point.every(Number.isFinite))
        fail("invalid_target", "The drop location is invalid.");
      destination.point = target.point.slice();
    }
    const route = routeFor(destination, metadata ? metadata.map(file => file.kind) : [reference.kind]);
    if (!route) fail("unsupported_target", "This target does not accept the selected item.");
    if (metadata?.length > 1 && route !== "open-design")
      fail("unsupported_target", "Choose one file for this drop target.");
    return {route,target:destination,files:metadata,reference};
  }

  function createReceiver({enabled = () => false, current, handlers = {}, delegate=[], load} = {}) {
    if (typeof current !== "function") throw Error("The drop receiver needs an active scope check.");
    const tickets = new WeakMap();

    function capture(source, target, scope) {
      if (!enabled()) fail("butter_disabled", "Butter drop is disabled.");
      active(null,() => current(scope));
      const preview = describe(source,target,!!load), prepare = handlers[preview.route];
      if (typeof prepare !== "function") fail("unsupported_target", "This drop is unavailable in this editor.");
      const ticket = Object.freeze({});
      // The read handles come from the approved native/UI selection only. They
      // are never stored in the preview returned to commands or to the UI.
      const files = delegate.includes(preview.route) ? [] : preview.files?.map((file, index) => {
        const from = source.files[index];
        return {from, entry:{...file, bytes:from.bytes, stream:typeof from.stream === "function" ? from.stream.bind(from) : undefined}};
      });
      tickets.set(ticket,{files,prepare,preview,scope,state:"ready",controller:new AbortController()});
      return ticket;
    }

    function inspect(ticket) {
      const record = tickets.get(ticket);
      if (!record) fail("ungranted_source", "Choose the source item again.");
      return {...JSON.parse(JSON.stringify(record.preview)), state:record.state};
    }

    function cancel(ticket) {
      const record = tickets.get(ticket);
      if (!record || !["ready","awaiting-consent","reading","preparing"].includes(record.state)) return false;
      record.state = "cancelled";
      record.controller.abort();
      record.files = null;
      return true;
    }

    async function apply(ticket, approve) {
      const record = tickets.get(ticket);
      if (!record || record.state !== "ready") fail("ungranted_source", "Choose the source item again.");
      if (typeof approve !== "function") fail("consent_required", "Approve this drop to continue.");
      const {scope,controller,files} = record, signal = controller.signal;
      const currentScope = () => enabled() && current(scope);
      const check = () => active(signal,currentScope);
      const commit = () => {
        check();
        if (record.state !== "preparing") fail("ungranted_source", "Choose the source item again.");
        record.state = "applying";
      };
      const inputs = [];
      let prepared;
      try {
        check();
        record.state = "awaiting-consent";
        if (await approve(inspect(ticket),signal) !== true) {
          cancel(ticket);
          fail("consent_required", "The drop was cancelled.");
        }
        check();
        record.state = "reading";
        for (const {entry,from} of files ?? []) {
          const input = await readBytes(entry,{signal,current:currentScope,load:load && (signal=>load(from,signal))});
          approved.set(input,{file:from,signal,current:currentScope});
          inputs.push(input);
        }
        check();
        record.state = "preparing";
        prepared = await record.prepare({...inspect(ticket),inputs,signal,scope,check});
        check();
        if (!prepared || typeof prepared.apply !== "function")
          fail("invalid_result", "The importer did not prepare this drop.");
        const result = await prepared.apply({scope,signal,check,commit});
        if (record.state === "cancelled") check();
        record.state = result === false ? "cancelled" : "complete";
        return result;
      } catch (error) {
        if (record.state !== "cancelled") record.state = "failed";
        throw error;
      } finally {
        for (const input of inputs) approved.delete(input);
        record.files = null;
        await prepared?.release?.();
      }
    }

    return Object.freeze({capture,inspect,apply,cancel});
  }

  return Object.freeze({fileMetadata,readBytes,describe,routeFor,createReceiver,consumeMedia,routes,limits});
})();
