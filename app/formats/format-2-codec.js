"use strict";
// Canonical Format 2.0 bytes and immutable, byte-indexed owner rows.
globalThis.AtriumFormat2 = (() => {
  const FORMAT = "2.0";
  const tableFeature = "notebook.table.v1";
  const tableKinds = new Set(["notebookTable","tableRow","tableColumn","tableCell","tableMerge"]);
  function withTable(header, enabled) {
    const required = header.requires || [], already = required.includes(tableFeature);
    if (enabled === already) return header;
    if (!["schematic","project"].includes(header.kind) || !["2.0","2.1"].includes(header.formatVersion) ||
        header.compatibleWith !== undefined ||
        enabled && header.formatVersion==="2.1" && !required.length && header.kind!=="project")
      throw new FormatError("unsupported-version","The existing owner format cannot safely change its table feature.");
    const next = {...header,requires:enabled ? [...required,tableFeature].sort(compare) : required.filter(f => f !== tableFeature)};
    const readerRequires = {...next.readerRequires};
    if (enabled) {
      next.formatVersion = "2.1";
      if (header.formatVersion === "2.1" && !required.length) next.tableBaseVersion = "2.1";
      if (own(header, "requires")) readerRequires[tableFeature] = "2.1";
    } else {
      delete readerRequires[tableFeature];
      if (!next.requires.length) {
        // Apricot emitted both forms. Retain the old header's spelling across an upgrade and Undo.
        if (!own(header.readerRequires ?? {}, tableFeature)) delete next.requires;
        next.formatVersion = header.tableBaseVersion ?? FORMAT;
      }
      delete next.tableBaseVersion;
    }
    if (Object.keys(readerRequires).length) next.readerRequires = readerRequires;
    else delete next.readerRequires;
    return next;
  }
  function tableReference(reference, file) {
    const enabled = file.header.requires?.includes(tableFeature) === true;
    if ((reference.requires?.includes(tableFeature) === true) === enabled) return reference;
    const next = {...reference}, required = (next.requires ?? []).filter(feature => feature !== tableFeature);
    if (enabled) required.push(tableFeature);
    if (required.length) next.requires = required.sort(compare);
    else delete next.requires;
    return next;
  }
  const documentSuffix = Object.freeze({schematic: ".wsch", pcb: ".wpcb", drawing: ".wdraw", panel: ".wpanel"});
  const documentKinds = new Set([...Object.keys(documentSuffix), "library"]);
  const manifestAdditions = Object.freeze({savedQuery:1, link:1, linkAnchor:1, savedView:1, slide:1,
    datasheetRef:1, datasheetAnnotation:1});
  const continuationFeature = "continuation-parts-v1";
  const headerLimit = 64 * 1024;
  const headerStringFields = new Set(["kind", "id", "formatVersion", "compatibleWith", "tableBaseVersion"]);
  const headerFields = new Set([...headerStringFields, "requires", "readerRequires"]);
  const headerKinds = Object.freeze(["project", ...Object.keys(documentSuffix), "library", "block", "snapshot", "import-index"]);
  const fileKinds = new Set(headerKinds);
  const digestRE = /^[0-9a-f]{64}$/;
  const ascii = /^[\x00-\x7f]*$/;
  const escapedOrNonASCII = /[\u0000-\u001f\\\u007f-\uffff]/;
  const encoded = () => new TextEncoder();
  const stored = new WeakMap();
  const own = (obj, key) => Object.hasOwn(obj, key);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

  class FormatError extends Error {
    constructor(code, message) { super(message); this.name = "FormatError"; this.code = code; }
  }
  function invalid(message) { throw new FormatError("invalid-format", message); }
  function readonly(message) { throw new FormatError("read-only-format", message); }

  // UTF-8 byte order agrees with Unicode scalar order for valid strings.
  function compare(a, b) {
    if (a === b) return 0;
    for (let ai = 0, bi = 0; ai < a.length && bi < b.length;) {
      const ac = a.codePointAt(ai), bc = b.codePointAt(bi);
      if (ac !== bc) return ac < bc ? -1 : 1;
      ai += ac > 0xffff ? 2 : 1;
      bi += bc > 0xffff ? 2 : 1;
    }
    return a.length < b.length ? -1 : 1;
  }
  const keyRank = key => key === "kind" ? 0 : key === "formatVersion" ? 1 : key === "id" ? 2 : 3;
  function keyOrder(a, b) { return keyRank(a) - keyRank(b) || compare(a, b); }
  function quote(value) {
    if (!/["\\\u0000-\u001f\u2028\u2029\ud800-\udfff]/u.test(value)) return '"' + value + '"';
    if (/[\ud800-\udfff]/u.test(value)) invalid("Unpaired Unicode surrogate.");
    return '"' + value.replace(/["\\\u0000-\u001f\u2028\u2029]/g, ch => {
      if (ch === '"' || ch === "\\") return "\\" + ch;
      return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    }) + '"';
  }
  function canonical(value, depth = 0) {
    if (depth > 512) invalid("A format record is nested too deeply.");
    if (value === null) return "null";
    switch (typeof value) {
      case "string": return quote(value);
      case "boolean": return value ? "true" : "false";
      case "number":
        if (!Number.isSafeInteger(value)) invalid("Native JSON numbers must be safe integers.");
        return String(value);
      case "object":
        if (Array.isArray(value)) return "[" + Array.from(value, v => canonical(v, depth + 1)).join(",") + "]";
        if (object(value)) return "{" + Object.keys(value).sort(keyOrder).map(key =>
          quote(key) + ":" + canonical(value[key], depth + 1)).join(",") + "}";
    }
    invalid("A native value must be JSON.");
  }
  function freeze(value) {
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value)) freeze(v);
      Object.freeze(value);
    }
    return value;
  }
  function readVersion(version) {
    const match = typeof version === "string" && /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.exec(version);
    if (!match) invalid("Invalid formatVersion.");
    return [+match[1], +match[2]];
  }
  const [currentMajor, currentMinor] = readVersion(FORMAT);
  function manifestVersion(header, records, projectRecord = row => row) {
    if (header.kind !== "project") return header.formatVersion;
    const [major, minor] = readVersion(header.formatVersion);
    if (major !== currentMajor) return header.formatVersion;
    let required = minor;
    for (const row of records) {
      const kind = projectRecord(row)?.kind;
      if (own(manifestAdditions, kind)) required = Math.max(required, manifestAdditions[kind]);
    }
    return required === minor ? header.formatVersion : major + "." + required;
  }
  // Archived snapshot members retain their own versions. This comparison is for live references.
  function checkMemberVersion(manifest, member) {
    const [rootMajor, rootMinor] = readVersion(manifest.header.formatVersion);
    const [major, minor] = readVersion(member.header.formatVersion);
    if (major !== rootMajor) throw new FormatError("invalid-member", "The live member and its manifest use different native major versions.");
    if (minor > rootMinor) throw new FormatError("invalid-member", "The manifest version is lower than its member.");
    const required = member.header.requires?.includes(tableFeature) === true;
    const reference = manifest.get(member.header.id);
    if (required !== (Array.isArray(reference?.requires) && reference.requires.includes(tableFeature)) ||
        required && !manifest.header.requires?.includes(tableFeature))
      throw new FormatError("invalid-member", "The table owner and its manifest declaration disagree.");
  }
  function recordIdentity(record, opaque = false) {
    if (!object(record) || typeof record.kind !== "string" || !record.kind ||
        typeof record.id !== "string" || !record.id || /[\ud800-\udfff]/u.test(record.id) || /[\ud800-\udfff]/u.test(record.kind)) {
      invalid("Every native record needs a kind and an ID.");
    }
    if (!opaque && record.order !== undefined && (typeof record.order !== "string" || !/^[0-9A-Za-z]*[1-9A-Za-z]$/.test(record.order))) {
      invalid("Invalid persisted order key.");
    }
  }
  function checkHeader(header, options) {
    recordIdentity(header);
    if (byteLength(header.id) > 1024) invalid("The native file ID is too long.");
    const [major, minor] = readVersion(header.formatVersion);
    if (options.kind !== undefined && options.kind !== header.kind) invalid("The file kind differs from its reference.");
    if (options.id !== undefined && options.id !== header.id) invalid("The file ID differs from its reference.");
    if (header.compatibleWith !== undefined) readVersion(header.compatibleWith);
    const declaredSubset = header.compatibleWith === FORMAT;
    if (major < currentMajor || major > currentMajor && !declaredSubset) {
      throw new FormatError("unsupported-version", "Unsupported native format " + header.formatVersion + ".");
    }
    const table = Array.isArray(header.requires) && header.requires.includes(tableFeature);
    if (table && (!["project","schematic"].includes(header.kind) || major !== 2 || minor < 1 || header.compatibleWith !== undefined))
      invalid("The notebook table feature needs a guarded native 2.1 schematic or manifest.");
    const qualifiedTable = table && minor === 1 &&
      (header.readerRequires?.[tableFeature] === undefined || header.readerRequires[tableFeature] === "2.1");
    if (header.tableBaseVersion !== undefined &&
        (!qualifiedTable || header.kind !== "project" || header.tableBaseVersion !== "2.1"))
      invalid("Only an upgraded table project can declare its preserved native 2.1 base.");
    const newer = major > currentMajor || minor > (qualifiedTable ? 1 : currentMinor);
    const opaque = !fileKinds.has(header.kind);
    if (opaque && (!newer || options.opaque !== true)) invalid("Unknown native file kind " + header.kind + ".");
    if (header.kind === "project" && (typeof header.name !== "string" || !header.name)) invalid("The project header needs a name.");
    const features = new Set(options.features);
    if (qualifiedTable) features.add(tableFeature);
    else if (table) features.delete(tableFeature);
    const required = header.requires === undefined ? [] : header.requires;
    if (!Array.isArray(required) || required.some(v => typeof v !== "string" || !v || /[\ud800-\udfff]/u.test(v))) {
      invalid("Invalid required feature list.");
    }
    const requiredSet = new Set(required);
    if (requiredSet.size !== required.length) invalid("Invalid required feature list.");
    const readerRequires = header.readerRequires;
    if (readerRequires !== undefined) {
      if (!object(readerRequires) || Object.keys(readerRequires).some(token => !requiredSet.has(token))) {
        invalid("Invalid required reader versions.");
      }
      for (const version of Object.values(readerRequires)) readVersion(version);
    }
    const requirement = token => Object.freeze({token,
      minimumReaderVersion: readerRequires && own(readerRequires, token) ? readerRequires[token] : null});
    if (requiredSet.has(continuationFeature)) {
      throw new FormatError("unsupported-feature", featureMessage(requirement(continuationFeature), header.formatVersion));
    }
    const unsupportedFeatures = Object.freeze(required.filter(token => !features.has(token)).map(requirement));
    return {newer, readOnly: opaque || major > currentMajor || unsupportedFeatures.length > 0, unsupportedFeatures};
  }
  function featureMessage({token, minimumReaderVersion}, formatVersion) {
    return "Unsupported required feature " + token + ". " + (minimumReaderVersion ?
      "A reader supporting native format " + minimumReaderVersion + " is required." : "The file declares native format " + formatVersion + ".");
  }
  function unsupportedMessage(file) {
    return (file.unsupportedFeatures ?? []).map(requirement => featureMessage(requirement,file.header.formatVersion)).join(" ");
  }
  function byteLength(line) { return ascii.test(line) ? line.length : encoded().encode(line).byteLength; }
  function row(record, line) { return {record: freeze(record), line, bytes: byteLength(line)}; }
  function writeRow(record) {
    recordIdentity(record);
    const line = canonical(record) + "\n";
    return row(JSON.parse(line), line);
  }
  function freezeCompactASCII(value, depth = 0) {
    if (depth > 512) return false;
    if (typeof value === "number") return Number.isSafeInteger(value);
    if (value === null || typeof value !== "object") return true;
    if (Array.isArray(value)) {
      for (const element of value) if (!freezeCompactASCII(element, depth + 1)) return false;
    } else {
      let previous = "", previousRank = -1;
      for (const key of Object.keys(value)) {
        const rank = keyRank(key);
        if (previousRank > rank || previousRank === rank && previous >= key ||
            !freezeCompactASCII(value[key], depth + 1)) return false;
        previous = key;
        previousRank = rank;
      }
    }
    Object.freeze(value);
    return true;
  }
  const unknownKind = (record, options) => options.knownKinds && !options.knownKinds.has(record?.kind);
  function readRow(text, index, options) {
    let record;
    try { record = JSON.parse(text); } catch { invalid("Invalid JSON at line " + index + "."); }
    const opaque = index !== 1 && unknownKind(record, options);
    recordIdentity(record, opaque);
    // For sorted, unescaped ASCII, the engine uses our exact compact encoding.
    // Retain the full encoder for escapes, Unicode and integer-index property enumeration.
    if (!escapedOrNonASCII.test(text) && freezeCompactASCII(record) && JSON.stringify(record) === text) {
      return {record, line: text + "\n", bytes: text.length + 1};
    }
    const retain = opaque || typeof options.nativeField === "function";
    try {
      if (canonical(record) === text) return row(record, text + "\n");
    } catch (error) {
      if (!retain || error?.code !== "invalid-format") throw error;
    }
    if (!retain) invalid("Noncanonical native JSON at line " + index + ".");
    const syntax = retainedSyntax(text, record, index, opaque ? null : options.nativeField, !opaque);
    return {...row(record, text + "\n"), retained:true, syntax, projected: opaque ? null : freeze(projectable(record))};
  }

  // Parse only the already-validated line to locate raw JSON tokens. The ordinary
  // canonical path needs no spans. An escaped key must be unique after decoding.
  function retainedSyntax(text, record, line, nativeField, keepSpans = true) {
    let cursor = 0;
    const path = [];
    const skip = () => { while (/^[ \t\r]$/.test(text[cursor] ?? "")) cursor++; };
    function stringToken() {
      const begin = cursor++;
      while (text[cursor] !== '"') cursor += text[cursor] === "\\" ? 2 : 1;
      return text.slice(begin, ++cursor);
    }
    function scan(value) {
      if (path.length > 512) invalid("A format record is nested too deeply.");
      const start = cursor, initial = text[cursor];
      let entries = null;
      if (initial === "{" || initial === "[") {
        const keyed = initial === "{", end = keyed ? "}" : "]", seen = keyed ? new Set() : null;
        if (keepSpans) entries = [];
        cursor++;
        let begin = cursor, index = 0;
        skip();
        while (text[cursor] !== end) {
          const spelling = keyed ? stringToken() : null;
          const key = keyed ? JSON.parse(spelling) : index++;
          if (keyed) {
            if (seen.has(key)) invalid("Noncanonical native JSON at line " + line + ": duplicate key.");
            if (line === 1 && path.length === 0 && headerFields.has(key) && spelling !== quote(key)) {
              invalid("Noncanonical structural field in the native header.");
            }
            seen.add(key);
            skip(); cursor++; skip();
          }
          path.push(key);
          const token = scan(value[key]);
          path.pop();
          skip();
          if (keepSpans) entries.push({key, begin, end:cursor, token});
          if (text[cursor] === end) break;
          begin = ++cursor;
          skip();
        }
        cursor++;
      } else if (initial === '"') {
        const spelling = stringToken();
        if (line === 1 && path.length === 1 && headerStringFields.has(path[0]) && spelling !== quote(value)) {
          invalid("Noncanonical structural value in the native header.");
        }
      }
      else {
        do { cursor++; } while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]));
        if (typeof value === "number" && nativeField?.(record.kind, path) === "integer" &&
            (!Number.isSafeInteger(value) || String(value) !== text.slice(start, cursor))) {
          invalid("Native geometry needs an exact safe integer at line " + line + ".");
        }
      }
      return keepSpans ? {start, end:cursor, entries} : null;
    }
    skip();
    return scan(record);
  }

  // An editor projection cannot safely use a JSON number beyond its numeric
  // range or an unpaired surrogate. The corresponding raw token remains stored.
  const unavailable = Symbol();
  function projectable(value) {
    if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) ||
        typeof value === "string" && /[\ud800-\udfff]/u.test(value)) return unavailable;
    if (Array.isArray(value)) {
      const projected = value.map(projectable);
      return projected.includes(unavailable) ? unavailable : projected;
    }
    if (!object(value)) return value;
    const fields = [];
    for (const [key, part] of Object.entries(value)) {
      const projected = projectable(part);
      if (projected !== unavailable && !/[\ud800-\udfff]/u.test(key)) fields.push([key,projected]);
    }
    return Object.fromEntries(fields);
  }

  function rewriteRetained(before, next, header, options) {
    const text = before.line;
    const append = (entry, previous, value) => text.slice(entry.begin, entry.token.start) +
      render(entry.token, previous, value) + text.slice(entry.token.end, entry.end);
    function render(token, previous, value) {
      const unchanged = () => text.slice(token.start, token.end);
      if (Object.is(previous, value)) return unchanged();
      const keyed = object(previous) && object(value), array = Array.isArray(previous) && Array.isArray(value);
      if (!keyed && !array) return canonical(value);
      const entries = token.entries, surviving = [], seen = new Set();
      if (array && previous.length && previous.every(item => typeof item?.id === "string") &&
          value.every(item => typeof item?.id === "string")) {
        const identities = new Map(entries.map(entry => [previous[entry.key].id, entry]));
        if (identities.size === entries.length) return "[" + value.map(item => {
          const entry = identities.get(item.id);
          return entry ? append(entry, previous[entry.key], item) : canonical(item);
        }).join(",") + "]";
      }
      for (const entry of entries) {
        const {key} = entry;
        if (!own(value, key)) continue;
        seen.add(key);
        surviving.push(append(entry, previous[key], value[key]));
      }
      const added = (array ? Array.from(value, (_, index) => index) : Object.keys(value)).filter(key => !seen.has(key));
      if (keyed) added.sort(keyOrder);
      for (const key of added) surviving.push((keyed ? quote(key) + ":" : "") + canonical(value[key]));
      if (surviving.length === 0 && entries.length === 0) return unchanged();
      return (keyed ? "{" : "[") + surviving.join(",") + (keyed ? "}" : "]");
    }
    const root = before.syntax;
    const updated = text.slice(0, root.start) + render(root, before.record, next) + text.slice(root.end, -1);
    return readRow(updated, header ? 1 : 2, options);
  }

  // AVL nodes hold the canonical byte lengths needed to locate a changed row.
  // Edits copy the search path and retain the ancestors of any in-flight save.
  const height = node => node?.height ?? 0;
  const size = node => node?.size ?? 0;
  const bytesBelow = node => node?.bytes ?? 0;
  function node(value, left = null, right = null) {
    let tailOrder = !value.opaque && typeof value.record.order === "string" ? value.record.order : "";
    if (left?.tailOrder > tailOrder) tailOrder = left.tailOrder;
    if (right?.tailOrder > tailOrder) tailOrder = right.tailOrder;
    return {value, left, right, height: 1 + Math.max(height(left), height(right)),
      size: 1 + size(left) + size(right), bytes: value.bytes + bytesBelow(left) + bytesBelow(right), tailOrder,
      retainsSyntax: !!(value.retained || left?.retainsSyntax || right?.retainsSyntax),
      crlf: !!(value.physical || left?.crlf || right?.crlf)};
  }
  function rotateLeft(root) {
    const pivot = root.right;
    return node(pivot.value, node(root.value, root.left, pivot.left), pivot.right);
  }
  function rotateRight(root) {
    const pivot = root.left;
    return node(pivot.value, pivot.left, node(root.value, pivot.right, root.right));
  }
  function balance(root) {
    const {left, right, value} = root;
    if (height(left) - height(right) > 1) {
      return rotateRight(height(left.left) < height(left.right) ? node(value, rotateLeft(left), right) : root);
    }
    if (height(right) - height(left) > 1) {
      return rotateLeft(height(right.right) < height(right.left) ? node(value, left, rotateRight(right)) : root);
    }
    return root;
  }
  function treeFromSorted(rows, start = 0, end = rows.length) {
    if (start === end) return null;
    const middle = start + Math.floor((end - start) / 2);
    return node(rows[middle], treeFromSorted(rows, start, middle), treeFromSorted(rows, middle + 1, end));
  }
  function locate(root, id) {
    let offset = 0;
    while (root) {
      const order = compare(id, root.value.record.id);
      if (order < 0) root = root.left;
      else {
        offset += bytesBelow(root.left);
        if (order === 0) return {offset, row: root.value};
        offset += root.value.bytes;
        root = root.right;
      }
    }
    return {offset, row: null};
  }
  function countBefore(root,id) {
    let count=0;
    while(root){
      if(compare(root.value.record.id,id)<0){count+=1+size(root.left);root=root.right;}
      else root=root.left;
    }
    return count;
  }
  function setRow(root, id, replacement) {
    if (!root) return replacement ? node(replacement) : null;
    const order = compare(id, root.value.record.id);
    if (order < 0) return balance(node(root.value, setRow(root.left, id, replacement), root.right));
    if (order > 0) return balance(node(root.value, root.left, setRow(root.right, id, replacement)));
    if (replacement) return node(replacement, root.left, root.right);
    if (!root.left) return root.right;
    if (!root.right) return root.left;
    let next = root.right;
    while (next.left) next = next.left;
    return balance(node(next.value, root.left, setRow(root.right, next.value.record.id, null)));
  }
  function *rows(root) {
    const pending=[];
    while(root || pending.length){
      while(root){pending.push(root);root=root.left;}
      root=pending.pop();
      yield root.value;
      root=root.right;
    }
  }
  function *records(root) { for (const r of rows(root)) yield r.record; }
  function get(file) {
    const data = stored.get(file);
    if (!data) invalid("Expected a parsed native file.");
    return data;
  }
  function handle(header, root, options, policy, opaque) {
    const find = id => id === header.record.id ? header : locate(root, id).row;
    const file = Object.freeze({
      header: header.record,
      projectedHeader: header.projected ?? header.record,
      size: size(root),
      byteLength: header.bytes + bytesBelow(root),
      tailOrder: root?.tailOrder ?? "",
      transport: header.physical || root?.crlf ? "crlf" : "lf",
      readOnly: policy.readOnly,
      newer: policy.newer,
      unsupportedFeatures: policy.unsupportedFeatures,
      retainsSyntax: !!(header.syntax || root?.retainsSyntax),
      get(id) { return locate(root, id).row?.record; },
      countRange(start,end) { return countBefore(root,end)-countBefore(root,start); },
      records() { return records(root); },
      *projectedRecords() { for (const entry of rows(root)) yield entry.projected ?? entry.record; },
      isOpaque(id) { return opaque.has(id); },
      hasRetainedSyntax(id) { return !!find(id)?.retained; },
      rawRecord(id) { const entry = find(id); return entry?.physical ?? entry?.line; },
      projectRecord(id) { const entry = find(id); return entry && (entry.projected ?? entry.record); },
    });
    stored.set(file, {header, root, options, policy, opaque});
    return file;
  }
  function checkedRows(header, entries, options, policy) {
    let past = null;
    const opaque = new Set();
    for (const entry of entries) {
      const {record} = entry;
      if (record.id === header.record.id || past !== null && compare(past, record.id) >= 0) {
        invalid("Native record IDs must be unique and sorted.");
      }
      if (tableKinds.has(record.kind) && (header.record.kind !== "schematic" || !header.record.requires?.includes(tableFeature)))
        invalid("Table records require the notebook.table.v1 schematic feature.");
      if (unknownKind(record, options)) { entry.opaque = true; opaque.add(record.id); }
      past = record.id;
    }
    return handle(header, treeFromSorted(entries), options, policy, opaque);
  }
  function parseOptions(options) {
    return {...options, knownKinds: options.knownKinds == null ? null : new Set(options.knownKinds)};
  }
  function create(header, data = [], options = {}) {
    const explicit = documentKinds.has(header?.kind) && header.formatVersion === FORMAT && header.requires === undefined;
    const entries = Array.from(data, writeRow).sort((a, b) => compare(a.record.id, b.record.id));
    if (header?.kind === "project") {
      const formatVersion = manifestVersion(header, entries, entry => entry.record);
      if (formatVersion !== header.formatVersion) header = {...header, formatVersion};
    }
    const head = writeRow(explicit ? {...header, requires: []} : header);
    if (head.bytes > headerLimit) invalid("The native file header is too large.");
    const settings = parseOptions(options);
    const policy = checkHeader(head.record, settings);
    if (policy.unsupportedFeatures.length) {
      throw new FormatError("unsupported-feature", "Unsupported required feature " + policy.unsupportedFeatures[0].token + ".");
    }
    return checkedRows(head, entries, settings, policy);
  }
  function decode(input) {
    if (typeof input === "string") return input;
    if (!ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) invalid("Expected native project bytes.");
    try { return new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(input); }
    catch { invalid("The native file is not valid UTF-8."); }
  }
  function splitHeader(input) {
    const string = typeof input === "string";
    if (!string) {
      if (ArrayBuffer.isView(input)) input = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else if (input instanceof ArrayBuffer) input = new Uint8Array(input);
      else invalid("Expected native project bytes.");
    }
    const limit = string ? input.slice(0, headerLimit) : input.subarray(0, headerLimit);
    const lf = limit.indexOf(string ? "\n" : 10);
    if (lf === -1) invalid("A native file needs a bounded first-line header and final LF.");
    const header = string ? limit.slice(0, lf) : decode(limit.subarray(0, lf));
    if (header.charCodeAt(0) === 0xfeff || byteLength(header) >= headerLimit) {
      invalid("A native file needs a bounded UTF-8 header without a BOM.");
    }
    return {header, body: () => string ? input.slice(lf + 1) : decode(input.subarray(lf + 1))};
  }
  function parse(input, {onDecoded, ...options} = {}) {
    const settings = parseOptions(options);
    const parts = splitHeader(input), crlfHeader = parts.header.endsWith("\r");
    const header = readRow(crlfHeader ? parts.header.slice(0,-1) : parts.header, 1, settings);
    if (crlfHeader) header.physical = parts.header + "\n";
    const policy = checkHeader(header.record, settings);
    if (!settings.knownKinds && settings.kindsByFile && own(settings.kindsByFile, header.record.kind)) {
      settings.knownKinds = new Set(settings.kindsByFile[header.record.kind]);
    }
    const text = parts.body();
    if (text && !text.endsWith("\n")) invalid("A native file needs final LF.");
    onDecoded?.(parts.header,text);
    let start = 0, line = 1;
    const entries = [];
    while (start < text.length) {
      const lf = text.indexOf("\n", start);
      const crlf = text.charCodeAt(lf - 1) === 13;
      const value = readRow(text.slice(start, crlf ? lf - 1 : lf), ++line, settings);
      if (crlf) value.physical = text.slice(start, lf + 1);
      entries.push(value);
      start = lf + 1;
    }
    return checkedRows(header, entries, settings, policy);
  }
  function *lines(file, physical = false) {
    const {header, root} = get(file);
    yield physical && header.physical || header.line;
    for (const r of rows(root)) yield physical && r.physical || r.line;
  }
  function rowTokens(file, id) {
    const {header, root} = get(file), entry = header.record.id === id ? header : locate(root, id).row;
    if (!entry) return null;
    const syntax = entry.syntax ?? retainedSyntax(entry.line, entry.record, entry === header ? 1 : 2);
    return freeze({text:entry.physical ?? entry.line, ...syntax});
  }
  function serializeRows(file, physical) {
    const {header, root} = get(file);
    // The AVL tree bounds recursion and already knows how many lines to join.
    const output = new Array(1 + size(root));
    output[0] = physical && header.physical || header.line;
    let index = 1;
    function append(node) {
      if (!node) return;
      append(node.left);
      output[index++] = physical && node.value.physical || node.value.line;
      append(node.right);
    }
    append(root);
    return encoded().encode(output.join(""));
  }
  function serialize(file) {
    // Logical project framing reverses a Git CRLF checkout. Physical writers
    // use serializePhysical to retain the original delimiter on every row.
    return serializeRows(file, false);
  }
  function serializePhysical(file) { return serializeRows(file, true); }
  function preserveDelimiter(row, previous) {
    if (previous.physical) row.physical = row.line.slice(0,-1) + "\r\n";
  }
  function addSplice(splices, offset, remove, insert) {
    const last = splices.at(-1);
    if (last && last.offset + last.remove === offset) {
      last.remove += remove;
      last.insert += insert;
    } else splices.push({offset, remove, insert});
  }
  function applyDelta(file, {put = [], remove = [], header, featureChange} = {}) {
    const base = get(file);
    if (file.readOnly) readonly("This native file is read-only.");
    const proposed = header ?? file.header;
    const wantsTable = proposed.requires?.includes(tableFeature) === true;
    const changedFeature = wantsTable !== (file.header.requires?.includes(tableFeature) === true);
    if (!changedFeature && (proposed.formatVersion !== file.header.formatVersion || proposed.tableBaseVersion !== file.header.tableBaseVersion))
      invalid("The edit cannot change the owner identity or format.");
    const retainOptional = changedFeature && !wantsTable && proposed.kind === "project";
    let versionRecords = put;
    if (retainOptional) {
      const replaced = new Set([...remove,...put.map(row => row.id)]);
      versionRecords = [...put,...Array.from(file.records()).filter(row => !replaced.has(row.id))];
    }
    const formatVersion = manifestVersion(proposed, versionRecords);
    if (formatVersion !== proposed.formatVersion) header = {...proposed, formatVersion};
    const head = header === undefined ? base.header : base.header.syntax ?
      rewriteRetained(base.header, header, true, base.options) : writeRow(header);
    if (head !== base.header) preserveDelimiter(head, base.header);
    if (head.bytes > headerLimit) invalid("The native file header is too large.");
    if (changedFeature) {
      const expected = withTable(file.header, wantsTable);
      if (featureChange !== tableFeature || manifestVersion(expected,versionRecords) !== head.record.formatVersion ||
          expected.tableBaseVersion !== head.record.tableBaseVersion ||
          canonical(expected.requires || []) !== canonical(head.record.requires || []) ||
          canonical(expected.readerRequires || {}) !== canonical(head.record.readerRequires || {}))
        invalid("The table upgrade needs explicit native feature authorization.");
    }
    if (head.record.id !== file.header.id || head.record.kind !== file.header.kind ||
        head.record.formatVersion !== formatVersion) invalid("The edit cannot change the owner identity or format.");
    const policy = head.line === base.header.line ? base.policy : checkHeader(head.record, base.options);
    if (policy.readOnly) readonly("The edited header requires a newer reader.");
    const replacements = new Map();
    for (const id of remove) {
      if (typeof id !== "string" || !id || id === file.header.id) invalid("Invalid removed record ID.");
      replacements.set(id, null);
    }
    for (const record of put) {
      recordIdentity(record);
      const {id, kind} = record;
      if (id === file.header.id || replacements.has(id)) invalid("The patch repeats a record ID.");
      if (tableKinds.has(kind) && (head.record.kind !== "schematic" || !head.record.requires?.includes(tableFeature)))
        invalid("Table records require the notebook.table.v1 schematic feature.");
      if (base.options.knownKinds && !base.options.knownKinds.has(kind)) readonly("The record kind cannot be authored.");
      const prior = locate(base.root, id).row;
      const updated = prior?.syntax ? rewriteRetained(prior, record, false, base.options) : writeRow(record);
      preserveDelimiter(updated, prior ?? base.header);
      replacements.set(id, updated);
    }
    const headerChanged = head.line !== base.header.line;
    const splices = [];
    if (headerChanged) addSplice(splices, 0, base.header.bytes, head.line);
    let root = base.root, changedRows = 0;
    for (const id of Array.from(replacements.keys()).sort(compare)) {
      if (base.opaque.has(id)) readonly("This record requires a newer reader.");
      const before = locate(base.root, id), after = replacements.get(id);
      if (before.row?.line === after?.line) continue;
      root = setRow(root, id, after);
      addSplice(splices, base.header.bytes + before.offset, before.row?.bytes ?? 0, after?.line ?? "");
      changedRows++;
    }
    if (changedFeature && !head.record.requires?.includes(tableFeature) && head.record.kind === "schematic")
      for (const record of records(root)) if (tableKinds.has(record.kind)) invalid("Remove all of the owned table records before removing notebook.table.v1.");
    if (!headerChanged && changedRows === 0) return {file, splices: [], changedRows, headerChanged};
    return {
      file: handle(head, root, base.options, policy, base.opaque),
      splices: file.transport === "lf" ? splices : null,
      changedRows,
      headerChanged,
    };
  }
  function edit(file, delta) { return applyDelta(file, delta).file; }

  // Use a fixed, locale-independent key for portable path collisions.
  // Dotless i is a separate fold class. Handle both forms of sharp S.
  function pathKey(path) {
    if (ascii.test(path)) return path.toLowerCase();
    return Array.from(path, ch => ch === "\u0131" ? ch :
      ch === "\u00df" || ch === "\u1e9e" ? "ss" : ch.toUpperCase().toLowerCase()).join("").normalize("NFC");
  }
  function portablePath(path) {
    if (typeof path !== "string" || (!ascii.test(path) && path !== path.normalize("NFC")) ||
        /[\\<>:"|?*\u0000-\u001f\u007f-\u009f]|[\ud800-\udfff]/u.test(path)) invalid("Invalid portable project path.");
    const parts = path.split("/");
    for (const [index, component] of parts.entries()) {
      if (!component || /[. ]$/.test(component) || pathKey(component) === ".git" ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)) {
        invalid("Invalid portable project path component.");
      }
      if (index < parts.length - 1 && /\.(?:wsch|wpcb|wdraw|wpanel|wlib)$/i.test(component)) {
        invalid("A native document path cannot be used as a directory.");
      }
    }
    return path;
  }
  function memberPath(path) {
    portablePath(path);
    const separator = path.indexOf("/");
    const root = pathKey(separator < 0 ? path : path.slice(0,separator));
    if (root === ".waffle" && !path.startsWith(".waffle/imports/")) invalid("Private paths are outside the version closure.");
    return path;
  }
  function manifestMembers(manifest) {
    if (manifest.header.kind !== "project") invalid("Expected a project manifest.");
    const result = [], seen = new Set();
    const tables = manifest.header.requires?.includes(tableFeature) === true;
    let hasTable = false;
    for (const record of manifest.records()) {
      const {kind, id, path, docKind, name, order} = record;
      let type, suffix, fileKind;
      if (kind === "document") {
        type = docKind;
        suffix = own(documentSuffix, docKind) && documentSuffix[docKind];
        if (typeof name !== "string" || !name) invalid("Invalid manifest document reference.");
        if (!suffix) {
          if (!manifest.newer || typeof docKind !== "string" || !docKind || fileKinds.has(docKind)) {
            invalid("Invalid manifest document reference.");
          }
          type = "opaque";
          fileKind = docKind;
        }
      } else if (kind === "library") { type = "library"; suffix = ".wlib"; }
      else if (kind === "layoutBlock") { type = "block"; suffix = ".wblock"; }
      else if (kind === "importIndex") type = "import-index";
      else continue;
      memberPath(path);
      if (suffix && !path.endsWith(suffix) ||
          kind === "document" && suffix && path.slice(path.lastIndexOf("/") + 1,-suffix.length) !== name ||
          (kind === "library" || kind === "layoutBlock") && !path.startsWith("libraries/") ||
          kind === "importIndex" && !path.startsWith(".waffle/imports/")) invalid("Invalid manifest member path.");
      const key = pathKey(path);
      if (seen.has(key)) invalid("Duplicate manifest member path.");
      seen.add(key);
      if (Array.isArray(record.requires) && record.requires.includes(tableFeature)) {
        if (!tables || kind !== "document" || type !== "schematic") invalid("The table member has no matching project requirement.");
        hasTable = true;
      }
      const ref = {path,id,kind:type};
      if (fileKind) ref.fileKind = fileKind;
      if (name !== undefined) ref.name = name;
      if (order !== undefined) ref.order = order;
      result.push(Object.freeze(ref));
    }
    if (tables && !hasTable) invalid("The table project needs a declared schematic owner.");
    return result;
  }
  function sha256(input) { return globalThis.AtriumSourceFile.sha256(input); }
  function checkDigest(digest) {
    if (typeof digest !== "string" || !digestRE.test(digest)) invalid("Expected a lowercase SHA-256 digest.");
    return digest;
  }
  function digestBytes(digest) {
    checkDigest(digest);
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(digest.slice(2 * i, 2 * i + 2), 16);
    return bytes;
  }
  function projectDigest(manifest, members) {
    const encoder = encoded();
    const prefix = encoder.encode("WAFFLE-PROJECT-V1\0");
    const body = serialize(manifest);
    const required = manifestMembers(manifest);
    const seen = new Set(), paths = new Set();
    let length = prefix.length + 16 + body.length;
    const entries = Array.from(members, ({path, sha256: digest}) => {
      const name = encoder.encode(memberPath(path));
      const key = pathKey(path);
      if (seen.has(key)) invalid("Duplicate project member path.");
      seen.add(key);
      paths.add(path);
      length += 4 + name.length + 32;
      return {path, name, digest: digestBytes(digest)};
    }).sort((a, b) => compare(a.path, b.path));
    for (const ref of required) {
      if (!paths.has(ref.path)) throw new FormatError("missing-member", "Missing project member " + ref.path + ".");
    }
    const framed = new Uint8Array(length), view = new DataView(framed.buffer);
    let at = 0;
    function write(bytes) { framed.set(bytes, at); at += bytes.length; }
    function u32(value) { view.setUint32(at, value); at += 4; }
    function u64(value) { u32(Math.floor(value / 0x100000000)); u32(value >>> 0); }
    write(prefix);
    u64(body.length);
    write(body);
    u64(entries.length);
    for (const entry of entries) {
      u32(entry.name.length);
      write(entry.name);
      write(entry.digest);
    }
    return sha256(framed);
  }

  return Object.freeze({FORMAT, tableFeature, withTable, tableReference, documentSuffix, headerKinds, isOptionalManifestKind:kind => own(manifestAdditions,kind),
    FormatError, compare, canonical, portablePath, memberPath, pathKey,
    sha256, checkDigest, readVersion, checkMemberVersion, unsupportedMessage, decodeText: decode, parse, create, applyDelta, edit,
    lines, rowTokens, serialize, serializePhysical, manifestMembers, projectDigest});
})();
