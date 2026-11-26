"use strict";

// Synchronous inside a worker / isolated headless process. The browser client sends data-only
// requests. No open document, DOM or host bridge is consulted by this dispatcher.
globalThis.AtriumTranslators = (() => {
  const R = globalThis.AtriumTranslatorRegistry;
  const limits = R.limits;
  const providers = Object.freeze({
    design: {global: "AtriumTranslatorAdapters", script: "formats/translator-adapters.js"},
    exchange: {global: "AtriumTranslatorExports", script: "formats/translator-exports.js"},
    manufacturing: {global: "AtriumTranslatorManufacturing", script: "formats/translator-manufacturing.js"}
  });
  const statuses = new Set(["kept", "approximated", "dropped"]);

  function format(id, direction) {
    const descriptor = R.get(id);
    if (!descriptor?.[direction]) throw Error((descriptor?.label || String(id)) + " has no " + direction + " translator.");
    return descriptor;
  }
  function load(descriptor, direction) {
    const module = providers[descriptor.adapter[direction]];
    globalThis.AtriumLoadTranslator?.(descriptor, direction, module.script);
    return globalThis[module.global];
  }
  function adapter(descriptor, direction) {
    const provider = load(descriptor, direction);
    const method = provider?.[descriptor.id]?.[direction];
    if (typeof method !== "function") throw Error(descriptor.label + " " + direction + " translator is unavailable in this build.");
    return method;
  }
  function byteView(value) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw Error("A translator input file must contain bytes.");
  }
  function readFiles(input) {
    if (!Array.isArray(input) || !input.length || input.length > limits.files) throw Error("Choose between one and " + limits.files + " files to translate.");
    let total = 0;
    return input.map(file => {
      if (!file || typeof file.name !== "string" || !file.name || file.name.length > 1024 || file.name.includes("\0")) throw Error("Invalid translator input file name.");
      if (file.path != null && (typeof file.path !== "string" || file.path.length > 4096 || file.path.includes("\0"))) throw Error("Invalid translator input file path.");
      const bytes = byteView(file.bytes);
      total += bytes.byteLength;
      if (bytes.byteLength > limits.fileBytes || total > limits.totalBytes) throw Error("The selected files exceed the translator size limit (256 MB per file, 1 GB total).");
      return {name: file.name, ...(file.path ? {path: file.path} : {}), bytes};
    });
  }
  function fidelity(descriptor, direction, members) {
    const rows = new Map(), producedRows = new Map(), notes = new Set();
    let omitted = 0;
    let budget = 64 * 1048576;
    function account(cost) {
      budget -= cost;
      if (budget < 0) throw Error("The source references exceed the fidelity report size limit.");
    }
    function ordinal(text) {
      if (typeof text !== "string") return null;
      let i = text.length;
      while (i > 0 && i > text.length - 12 && text.charCodeAt(i-1) >= 48 && text.charCodeAt(i-1) <= 57) i--;
      if (i === text.length || i > 0 && text.charCodeAt(i-1) >= 48 && text.charCodeAt(i-1) <= 57) return null;
      const digits = text.slice(i);
      return {prefix: text.slice(0,i), number: Number(digits), width: digits.length > 1 && digits[0] === "0" ? digits.length : 0};
    }
    // Store all source identities. Contiguous record numbers share a range; UUIDs and
    // arbitrary identifiers remain exact strings. File-only counts are explicit nulls.
    function pack(values, object, count = 1) {
      if (count === 1 && typeof object === "string" && values.length) {
        const next = ordinal(object), last = values[values.length-1];
        if (next && last && last.prefix === next.prefix && last.width === next.width && last.last + 1 === next.number) {
          last.last = next.number;
          return;
        }
        const prev = next && ordinal(last);
        if (prev && prev.prefix === next.prefix && prev.width === next.width && prev.number + 1 === next.number) {
          values[values.length-1] = {prefix: prev.prefix, first: prev.number, last: next.number, width: prev.width};
          account(32);
          return;
        }
      }
      account(16 + (object?.length || 0) * 2);
      values.push(count === 1 ? object : {object, count});
    }
    function add(kind, status, source, reason, count = 1) {
      if (count === 0) return;
      if (typeof kind !== "string" || !kind || kind.length > 128 || !statuses.has(status) ||
          !source || typeof source.file !== "string" || !source.file || source.file.length > 4096 ||
          !Number.isSafeInteger(count) || count < 1) throw Error("Invalid fidelity report entry.");
      let item = rows.get(kind);
      if (!item) {
        if (rows.size >= 512) throw Error("The translator reported too many different object kinds.");
        item = {row: {kind, referenceCount: 0, kept: 0, approximated: 0, dropped: 0, references: []}, files: new Map()};
        rows.set(kind, item);
      }
      const row = item.row, object = source.object == null ? null : String(source.object);
      const why = reason ? String(reason).slice(0, 2048) : undefined;
      row.referenceCount++;
      row[status] += count;
      if (!Number.isSafeInteger(row[status])) throw Error("The fidelity count exceeds the supported range.");
      if (row.references.length < 256) {
        account(64 + (source.file.length + (object?.length || 0) + (why?.length || 0)) * 2);
        row.references.push({status, source: {file: source.file, ...(object != null ? {object} : {})}, count, ...(why ? {reason: why} : {})});
        return;
      }
      const key = JSON.stringify([status, source.file, why]);
      let group = item.files.get(key);
      if (!group) {
        account(128 + key.length * 2);
        group = {status, source: {file: source.file}, count: 0, ...(why ? {reason: why} : {}), grouped: true, referenceCount: 0, objects: []};
        item.files.set(key, group);
        row.references.push(group);
      }
      group.count += count;
      group.referenceCount++;
      pack(group.objects, object, count);
    }
    // A single source record may create several editable objects. The Round 3
    // round-trip inventory counts these separately from source-object fidelity.
    function produced(documentKind, kind, source, id) {
      if (typeof documentKind !== "string" || !documentKind || documentKind.length > 128 ||
          typeof kind !== "string" || !kind || kind.length > 128 || !source || typeof source.file !== "string" ||
          !source.file || source.file.length > 4096) throw Error("Invalid native object report entry.");
      const key = documentKind + "\0" + kind;
      let entry = producedRows.get(key);
      if (!entry) {
        if (producedRows.size >= 512) throw Error("The translator reported too many native object kinds.");
        entry = {row: {documentKind, kind, count: 0, references: []}, files: new Map()};
        producedRows.set(key, entry);
      }
      entry.row.count++;
      const refs = entry.row.references, object = source.object == null ? null : String(source.object), nativeId = id == null ? null : String(id);
      if (refs.length < 256) {
        account(64 + (source.file.length + (object?.length || 0) + (nativeId?.length || 0)) * 2);
        refs.push({source: {file: source.file, ...(object != null ? {object} : {})}, ...(nativeId != null ? {id: nativeId} : {}), count: 1});
      } else {
        let group = entry.files.get(source.file);
        if (!group) {
          account(128 + 2*source.file.length);
          group = {source: {file: source.file}, count: 0, grouped: true, referenceCount: 0, objects: [], ids: []};
          entry.files.set(source.file, group);
          refs.push(group);
        }
        group.count++;
        group.referenceCount++;
        pack(group.objects, object);
        pack(group.ids, nativeId);
      }
    }
    function note(message) {
      const value = String(message || "").slice(0, 2048);
      if (!value || notes.has(value)) return;
      if (notes.size < 256) notes.add(value);
      else omitted++;
    }
    function report(page) {
      const result = {version: 1, translator: descriptor.id, ...(members?.length > 1 ? {translators: members} : {}), direction,
        kinds: Array.from(rows.values(), ({row}) => row).sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
        modelObjects: Array.from(producedRows.values(), ({row}) => row),
        notes: [...notes, ...(omitted ? [omitted + " additional translator notes."] : [])]};
      if (page != null) result.referencePage = R.referencePage(result, page);
      return result;
    }
    return {add, produced, note, report};
  }

  function importFiles(input, options = {}) {
    const files = readFiles(input);
    const selectedSheet=files.some(f=>/\.schdoc$/i.test(f.name));
    const detected = files.map(file => {
      if(selectedSheet && /^notebook-[0-9a-f]{64}\.png$/.test(file.name))return format("altium","import");
      const descriptor = R.detect(file.name, file.bytes);
      if (descriptor) return descriptor;
      const named = R.forName(file.name, null);
      if (named && !named.import) format(named.id, "import");
      throw Error("Choose a Waffle project or a supported design, library, netlist or mechanical file. Unrecognised input: " + file.name);
    });
    const explicit = options.translator == null ? null : format(options.translator, "import");
    const members = [...new Set(detected)], designs = members.filter(row => row.group === "design");
    const companionOwner = designs.find(row => members.some(member => row.companions?.includes(member.id)));
    const main = explicit || companionOwner || designs[0] || members[0], hasMain = members.includes(main);
    const allowed = row => row === main || main.group && (row.group === main.group ||
      members.some(member => member.group === main.group && member.companions?.includes(row.id)));
    if (!hasMain || !members.every(allowed)) throw Error("The selected files cannot be opened together by the " + main.label + " translator.");
    // Design sets may mix Altium, KiCad, Eagle and EasyEDA, for example a board and its
    // library. Companion STEP files are read only as references by the design importer.
    for (const row of members) if (row !== main && row.group && row.group === main.group) load(row, "import");
    const formats = detected.map(row => row.id), sink = fidelity(main, "import", members.map(row => row.id));
    const result = adapter(main, "import")(files, {...options, formats}, sink);
    if (!result?.model || !Array.isArray(result.model.documents) || !Array.isArray(result.model.library) || !result.provenance)
      throw Error(main.label + " returned an incomplete import.");
    return {model: result.model, report: sink.report(options.referencePage), provenance: result.provenance};
  }

  function exportFiles(id, model, options = {}, prepared) {
    if (id === "odb" && options.odbEnabled !== true)
      throw Object.assign(Error("Enable ODB++ output in Experimental features to export this product model."), {code:"butter_disabled"});
    const descriptor = format(id, "export");
    if (!model || !Array.isArray(model.documents) || !Array.isArray(model.library)) throw Error("A project snapshot is required for export.");
    const sink = fidelity(descriptor, "export");
    const result = adapter(descriptor, "export")(model, options, sink, prepared);
    const files = Array.isArray(result) ? result : result?.files;
    if (!Array.isArray(files) || files.length > limits.files) throw Error(descriptor.label + " returned an invalid output file list.");
    const names = new Set();
    let size = 0;
    for (const file of files) {
      if (!file || typeof file.name !== "string" || !file.name || file.name.length > 4096 || /[\x00-\x1f:\\]/.test(file.name) ||
          file.name.split("/").some(part => !part || part === "." || part === "..")) throw Error("The translator returned an invalid output file name.");
      if (names.has(file.name)) throw Error("The translator returned two files named " + file.name + ".");
      names.add(file.name);
      if ((typeof file.text === "string") === (file.bytes != null)) throw Error("Expected one text or binary output per file.");
      // Text is bounded in UTF-16 code units, binary in bytes, without making a second
      // copy of a large Gerber or STEP output simply to count its length.
      const length = file.bytes == null ? file.text.length : byteView(file.bytes).byteLength;
      size += length;
      if (length > limits.fileBytes || size > limits.totalBytes) throw Error("Translated files exceed the output size limit.");
    }
    return {files, report: sink.report(options.referencePage), ...(result.details != null ? {details: result.details} : {})};
  }
  function measured(component, operation, options, work) {
    const timing = globalThis.AtriumDiagnostics?.performance?.begin(component, operation);
    if (!timing) return work();
    let outcome = "failed";
    try {
      const result = work();
      outcome = "completed";
      return result;
    } catch (error) {
      if (options?.signal?.aborted || error?.name === "AbortError") outcome = "cancelled";
      throw error;
    } finally { timing.end(outcome); }
  }
  function exportSession() {
    // The owner supplies immutable project snapshots and releases this function
    // when the output job finishes. Each export still owns its own fidelity sink.
    const prepared = new WeakMap();
    return (id, model, options) => measured("export", "build", options, () => exportFiles(id, model, options, prepared));
  }
  return Object.freeze({detect: R.detect,
    import:(input,options={})=>measured("import", "load", options, () => importFiles(input,options)),
    export:(id,model,options={})=>measured("export", "build", options, () => exportFiles(id,model,options)), exportSession, limits});
})();
