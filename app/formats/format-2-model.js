"use strict";
// Project members project to the editor's existing typed model. Filesystem grants belong to callers.
globalThis.AtriumFormat2Model = (() => {
  const G = globalThis, F = G.AtriumFormat2, V = G.AtriumFormat2Values, U = G.AtriumFormat2Units;
  if (!G.AtriumPourMarker && typeof require === "function") require("../pcb/pour-marker.js");
  if (!G.AtriumPourMarker && typeof importScripts === "function") importScripts("../pcb/pour-marker.js");
  const FORMAT = F.FORMAT, EDITOR_FORMAT = "1.5";
  const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const ITEM_KINDS = new Set(["part", "wire", "track", "graphic", "label", "netlabel", "junction", "via", "pad",
    "polygon", "power", "port", "offsheet", "sheetsymbol", "bus", "busentry", "noerc", "textframe", "image",
    "frame", "richtext", "math", "calculation", "widget", "imageMarkup", "notesLayer", "sticky", "callout", "reviewItem", "inkStroke"]);
  const TABLE_ROWS = ["notebookTable","tableRow","tableColumn","tableCell","tableMerge"];
  const tableItem = item => item?.kind === "textframe" && item.widget?.type === "table" && item.widget.state?.tableVersion === 1;
  function tableFormat() {
    if (!G.AtriumTableFormat && typeof importScripts === "function") importScripts("../notebook/table-data.js","../notebook/table-format.js");
    if (!G.AtriumTableFormat && typeof require === "function") { require("../notebook/table-data.js"); require("../notebook/table-format.js"); }
    if (!G.AtriumTableFormat) fail("Load the notebook.table.v1 table reader.");
    return G.AtriumTableFormat;
  }
  const PROJECT_RECORDS = new Set(["document", "library", "layoutBlock", "importIndex", "release", "projectSetting",
    "rule", "signal", "tag", "variant", "bomView", "outputJob", "reviewThread", "reviewReply",
    "link", "linkAnchor", "savedQuery", "savedView", "slide", "datasheetRef", "datasheetAnnotation"]);
  const DOCUMENT_RECORDS = new Set([...ITEM_KINDS, "documentSettings", "panelCell", "drawingView", "drawingDimension",
    "boardBody", "modelAlias", "layer", "copperRegion"]);
  const LIBRARY_RECORDS = new Set(["librarySettings", "pin", "pad", "shape", "boardBody", "modelAlias"]);
  const BLOCK_RECORDS = new Set([...ITEM_KINDS, "blockSettings", "blockLibrary"]);
  const SNAPSHOT_RECORDS = new Set(["snapshotMember", "snapshotModel"]);
  const known = {project: PROJECT_RECORDS, schematic: new Set([...DOCUMENT_RECORDS,...TABLE_ROWS]), pcb: DOCUMENT_RECORDS, drawing: DOCUMENT_RECORDS,
    panel: DOCUMENT_RECORDS, library: LIBRARY_RECORDS, block: BLOCK_RECORDS, snapshot: SNAPSHOT_RECORDS};
  const SOURCE_DOCUMENT = new Set(["sourceName", "sourceEncoding", "sourceSha256", "sourceProject", "sourceRules",
    "sourceRuleChecks", "sourceRuleLayers", "sourceClasses", "kicadUuid", "kicadInstances", "kicadInstanceList", "importPlaceholder"]);
  const SOURCE_ITEM = new Set(["sourceRecord", "sourcePourOver", "schSource", "altiumSourceId", "kicadSourceId", "kicadPath",
    "kicadPaths", "kicadUuid", "sourceDrillTool"]);
  const LOCAL = new Set(["ui", "view", "history", "activeVariant", "variantApplied", "atriumCompat"]);
  const MEDIA = Object.freeze({snapshot: "application/vnd.waffle.snapshot+jsonl", text: "application/vnd.waffle.records+jsonl",
    step: "model/step"});
  const IMAGE_MEDIA = new Set(["image/heic", "image/jpeg", "image/png", "image/webp", "image/svg+xml", "image/gif"]);
  const IMAGE_EXT = Object.freeze({"image/heic": "heic", "image/jpeg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif"});
  const object = value => !!value && typeof value === "object" && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const encodeText = text => new TextEncoder().encode(text);
  const typed = (kind, id, extra = {}) => ({...extra, kind, formatVersion: FORMAT, id});
  function fail(message) { throw new F.FormatError("invalid-model", message); }
  function missing(path) { throw new F.FormatError("missing-member", "Missing project member " + path + "."); }
  function fields(value, excluded) { return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key))); }
  function readOptions(kind, id, features) { return {kind, id, features, knownKinds: known[kind], nativeField: V.nativeField}; }
  function parse(bytes, options = {}) {
    return F.parse(bytes, {...options, kindsByFile: known, nativeField: V.nativeField});
  }

  const LINK_MAPS = [["links", "link"], ["linkAnchors", "linkAnchor"]];
  function linkValue(kind, value, id, reading = false) {
    if (!G.AtriumLinkRecord && typeof importScripts === "function") importScripts("../project/link-record.js");
    // @ts-ignore CommonJS readers use the same record contract as the worker.
    if (!G.AtriumLinkRecord && typeof require === "function") require("../project/link-record.js");
    const L = G.AtriumLinkRecord;
    if (!object(value) || value.id !== id) fail("Invalid native " + kind + " identity.");
    let record = value;
    if (reading) {
      const {id, source, target, label, documentId, ownerId, terminal, terminalId} = value;
      if (kind === "link" && object(source) && object(target)) {
        const select = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value, name)).map(name => [name, value[name]]));
        record = {id, source:select(source, ["objectId", "documentId", "kind"]),
          target:select(target, ["projectId", "objectId", "fragment"]), ...(label !== undefined && {label})};
      } else if (kind === "linkAnchor") {
        record = {id, kind:value.kind, documentId, ownerId, ...(terminal !== undefined && {terminal}),
          ...(terminalId !== undefined && {terminalId})};
      }
    }
    if (!(kind === "link" ? L.validRecord(record) : L.validAnchor(record))) fail("Invalid native " + kind + " record.");
    return record;
  }

  const absent = Symbol();
  const has = (value, key) => value != null && Object.hasOwn(value, key);
  const get = (value, key) => has(value, key) ? value[key] : absent;
  const projectedRecord = (file, id, raw = file.get(id)) => file.hasRetainedSyntax?.(id) ? file.projectRecord(id) : raw;
  function compatibility(file) {
    return {readOnly:file.header.formatVersion,
      ...(file.unsupportedFeatures?.length ? {unsupportedFeatures:file.unsupportedFeatures} : {})};
  }
  function sameNativeValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => sameNativeValue(value, b[i]));
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => has(b, key) && sameNativeValue(a[key], b[key]));
  }
  // Apply only semantic changes to the prior native value. Typed projections can
  // supply a display default or omit fields such as annotations on an asset reference.
  function retainedValue(raw, before, after) {
    if (before === after) return raw;
    if (object(raw) && object(before) && object(after)) {
      const pairs = [];
      for (const key of new Set([...Object.keys(raw), ...Object.keys(before), ...Object.keys(after)])) {
        const previous = get(raw, key), requested = get(after, key);
        if (previous !== absent && key.startsWith("x-")) {
          if (requested !== absent && !sameNativeValue(get(before, key), requested)) {
            throw new F.FormatError("read-only-format", "This extension value requires its own reader.");
          }
          pairs.push([key, previous]);
        } else {
          const value = retainedValue(previous, get(before, key), requested);
          if (value !== absent) pairs.push([key, value]);
        }
      }
      return Object.fromEntries(pairs);
    }
    if (Array.isArray(raw) && Array.isArray(before) && Array.isArray(after) && raw.length === before.length) {
      const indexes = new Map(before.flatMap((item, index) => typeof item?.id === "string" ? [[item.id, index]] : []));
      if (indexes.size === before.length && after.every(item => typeof item?.id === "string")) {
        return after.map(item => {
          const index = indexes.get(item.id);
          return index === undefined ? item : retainedValue(raw[index], before[index], item);
        });
      }
      if (after.length === before.length) return after.map((value, i) => retainedValue(raw[i], before[i], value));
    }
    return sameNativeValue(before, after) ? raw : after;
  }
  function retainedRows(file, before, after) {
    const baseline = new Map(before.map(row => [row.id, row]));
    const ids = new Set(), put = [];
    for (const row of after) {
      ids.add(row.id);
      const raw = file.get(row.id), old = baseline.get(row.id);
      const retained = old && raw ? retainedValue(raw, old, row) : row;
      if (!sameNativeValue(raw, retained)) put.push(retained);
    }
    return {put, remove:before.filter(row => !ids.has(row.id) && !file.isOpaque(row.id)).map(row => row.id)};
  }

  function between(before, after = null) {
    if (G.AtriumCollabCRDT) return G.AtriumCollabCRDT.between(before, after);
    const left = before || "";
    let prefix = "";
    for (let i = 0; ; i++) {
      const low = i < left.length ? DIGITS.indexOf(left[i]) : 0;
      const high = after == null ? 62 : i < after.length ? DIGITS.indexOf(after[i]) : 0;
      if (high - low > 1) return prefix + DIGITS[(low + high) >> 1];
      prefix += DIGITS[low];
      if (high > low) after = null;
    }
  }
  function initialOrder(n) {
    if (G.AtriumCollabCRDT) return G.AtriumCollabCRDT.spread(n);
    let width = 1;
    while (62 ** width < (n + 2) * 4) width++;
    const step = Math.floor(62 ** width / (n + 1));
    return Array.from({length: n}, (_, index) => {
      let value = (index + 1) * step, key = "";
      for (let i = 0; i < width; i++) {
        key = DIGITS[value % 62] + key;
        value = Math.floor(value / 62);
      }
      return key.replace(/0+$/, "") || "V";
    });
  }
  const validOrder = value => typeof value === "string" && /^[0-9A-Za-z]*[1-9A-Za-z]$/.test(value);
  const ordered = (a, b) => F.compare(a.order ?? "", b.order ?? "") || F.compare(a.id, b.id);
  function uuidAllocator() {
    if (!G.AtriumUUID && typeof importScripts === "function") importScripts("../core/uuid-v7.js");
    // @ts-ignore CommonJS callers load the same allocator as the editor and worker.
    if (!G.AtriumUUID && typeof require === "function") require("../core/uuid-v7.js");
    return G.AtriumUUID;
  }
  const newRecordId = () => uuidAllocator().next();
  function idPool(taken = []) {
    const ids = new Set(taken);
    return preferred => {
      let id = preferred;
      while (!id || ids.has(id)) id = newRecordId();
      ids.add(id);
      return id;
    };
  }
  function legacyIds(document, id) {
    return [id, ...document.items.map(item => item.id).filter(Boolean)];
  }
  function namePart(name, fallback) {
    const s = String(name || "").normalize("NFC").replace(/[\\/< >:"|?*\u0000-\u001f]/g, ch => ch === " " ? " " : "-").trim().replace(/[. ]+$/, "");
    let candidate = s ? Array.from(s).slice(0, 64).join("") : fallback;
    try { return F.portablePath(candidate); }
    catch { return F.portablePath("_" + candidate); }
  }
  function pathPool(reserved = []) {
    const seen = new Set(reserved.map(F.pathKey));
    return (directory, name, suffix) => {
      const stem = namePart(name, "Untitled");
      let path = directory + stem + suffix;
      for (let n = 2; seen.has(F.pathKey(path)); n++) path = directory + stem + " (" + n + ")" + suffix;
      seen.add(F.pathKey(path));
      return F.portablePath(path);
    };
  }
  const pathStem = (path, suffix) => path.split("/").at(-1).slice(0, -suffix.length);
  function byteView(bytes) {
    if (!ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) fail("Expected binary asset bytes.");
    return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  function assetRef(value) {
    if (!object(value) || typeof value.mediaType !== "string" || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value.mediaType) ||
        !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) fail("Invalid native asset reference.");
    return Object.freeze({sha256: F.checkDigest(value.sha256), mediaType: value.mediaType, byteLength: value.byteLength});
  }
  function imageRef(value) {
    const ref = assetRef(value);
    if (!IMAGE_MEDIA.has(ref.mediaType)) fail("The image reference requires an image payload.");
    return ref;
  }
  const assetPath = ref => "assets/" + assetRef(ref).sha256;
  function modelRef(value) {
    if (!object(value) || value.mediaType !== MEDIA.step || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1) fail("Invalid native model reference.");
    return Object.freeze({sha256: F.checkDigest(value.sha256), mediaType: value.mediaType, byteLength: value.byteLength});
  }
  const modelPath = ref => "models/" + modelRef(ref).sha256 + ".step.gz";

  function base64(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) fail("Invalid base64 asset bytes.");
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(text);
    if (typeof G.atob === "function") return Uint8Array.from(G.atob(text), c => c.charCodeAt(0));
    if (G.AtriumImportFormats) return G.AtriumImportFormats.base64(text);
    fail("This loader lacks a base64 decoder.");
  }
  function attach(state, input, mediaType) {
    if (!state) fail("Import or stage the attachment before saving its reference.");
    const bytes = byteView(input), ref = assetRef({sha256: F.sha256(bytes), mediaType, byteLength: bytes.length});
    const path = assetPath(ref);
    if (!state.payloads.has(path)) state.payloads.set(path, {path, ref, bytes, sha256: ref.sha256});
    return ref;
  }
  function attachedModel(state, input) {
    if (!state) fail("Stage the model before saving a new model reference.");
    const bytes = byteView(input);
    const ref = modelRef({sha256: F.sha256(bytes), mediaType: MEDIA.step, byteLength: bytes.length});
    const path = modelPath(ref);
    if (!state.models.has(path)) state.models.set(path, {path, ref, raw: bytes});
    return ref;
  }
  function legacyZlib(text) {
    const bytes = base64(text);
    if (G.AtriumFormat2Models?.inflateLegacy) return G.AtriumFormat2Models.inflateLegacy(bytes);
    if (!G.AtriumImportFormats && typeof importScripts === "function") importScripts("../formats/sexpr.js");
    if (!G.AtriumImportFormats || bytes.length < 6 || (bytes[0] & 15) !== 8 ||
        (bytes[0] * 256 + bytes[1]) % 31 !== 0 || (bytes[1] & 32) !== 0) fail("Invalid legacy compressed STEP payload.");
    const raw = G.AtriumImportFormats.inflate(bytes.subarray(2, -4), 0, 32 * 1024 * 1024);
    let a = 1, b = 0;
    for (const v of raw) { a = (a + v) % 65521; b = (b + a) % 65521; }
    if (((b << 16 | a) >>> 0) !== new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(bytes.length - 4)) {
      fail("The legacy model checksum is invalid.");
    }
    return raw;
  }
  function imageAsset(item, state) {
    if (typeof item.src !== "string") fail("The image has no retained bytes.");
    const data = /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml|heic));base64,(.*)$/i.exec(item.src);
    if (!data) fail("Unsupported legacy inline image.");
    const raw = base64(data[2]);
    const declared = data[1].toLowerCase().replace("image/jpg", "image/jpeg");
    let info;
    if (!G.AtriumNotebookImageFormat && typeof importScripts === "function") {
      try { importScripts("../notebook/notebook-image-format.js"); } catch { /* This runtime can preserve an uninspected original. */ }
    }
    try { info = G.AtriumNotebookImageFormat?.info(raw); } catch { /* Keep the raw legacy payload with unavailable extent. */ }
    const mediaType = IMAGE_MEDIA.has(info?.mediaType) ? info.mediaType : declared;
    const name = [item.name, item.sourceName, item.file].find(value => typeof value === "string" && value.trim());
    const basename = name?.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f]/g, "").trim();
    return {asset: attach(state, raw, mediaType), name: basename || "Image." + IMAGE_EXT[mediaType],
      ...(info?.extent ? {extent: info.extent} : {})};
  }
  function modelFor(value, state, blobs, local) {
    if (value.model) return modelRef(value.model);
    if (typeof value.stepText === "string" && value.stepText.length) return attachedModel(state, encodeText(value.stepText));
    if (typeof value.zlib === "string" && value.zlib.length) return attachedModel(state, legacyZlib(value.zlib));
    if (value.sha256 && typeof blobs?.[value.sha256]?.stepText === "string") {
      return attachedModel(state, encodeText(blobs[value.sha256].stepText));
    }
    if (typeof value.assetId === "string") return local?.(value.assetId);
    return undefined;
  }
  function modelLink(value, state, blobs) {
    const data = fields(value, new Set(["sha256", "stepText", "zlib", "assetId", "model", "checksum"]));
    const model = modelFor(value, state, blobs);
    if (model) data.model = model;
    else if (state && typeof data.file === "string" && data.file) {
      state.modelDiagnostics.push({name: data.file.split(/[\\/]/).at(-1), reason: "Missing model payload."});
    }
    if (typeof data.file === "string") data.file = data.file.split(/[\\/]/).at(-1);
    return data;
  }
  function resolveAliases(models, state, blobs) {
    const items = new Map(models.map(entry => [entry.id, entry])), resolved = new Map(), active = new Set();
    function resolve(id) {
      if (resolved.has(id)) return resolved.get(id);
      const entry = items.get(id);
      if (!entry || active.has(id)) return undefined;
      active.add(id);
      const ref = modelFor(entry, state, blobs, resolve);
      active.delete(id);
      resolved.set(id, ref);
      return ref;
    }
    return models.map(entry => {
      const alias = fields(entry, new Set(["sha256", "stepText", "zlib", "assetId", "model", "checksum"]));
      const model = resolve(entry.id);
      if (typeof alias.file === "string") alias.file = alias.file.split(/[\\/]/).at(-1);
      if (!model && state && alias.file) state.modelDiagnostics.push({id: alias.id, name: alias.file, reason: "Missing model payload."});
      return model ? {...alias, model} : alias;
    });
  }
  function residualFingerprint(owner, id, property, value) {
    return F.sha256(encodeText(F.canonical({owner, id, property, value})));
  }
  function residual(state, owner, id, recordKind) {
    if (!state?.trackResiduals) return undefined;
    return (path, quantity, unit, value) => {
      const property = "/" + path.map(part => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
      state.residuals.push({owner, id, recordKind, property, unit, nativeValue: value, ...quantity,
        fingerprint: residualFingerprint(owner, id, property, value)});
    };
  }
  // The exporter supplies the actual native scalar and the unit of its typed field.
  // The exact fraction is in translated units, before the writer's target transform.
  // Legacy proofs without a kind require independent source-kind evidence from the writer.
  function restoreResidual(current, proof) {
    if (!object(current) || !object(proof)) return null;
    const {owner, id, recordKind, property, value, unit} = current;
    if (typeof owner !== "string" || !owner || typeof id !== "string" || !id ||
        typeof property !== "string" || !property.startsWith("/") || /~(?![01])/.test(property) ||
        (unit !== "nm" && unit !== "nanodeg") || !Number.isSafeInteger(value) ||
        proof.owner !== owner || proof.id !== id || proof.property !== property || proof.unit !== unit ||
        proof.nativeValue !== undefined && proof.nativeValue !== value) return null;
    if (proof.recordKind !== undefined &&
        (typeof proof.recordKind !== "string" || !proof.recordKind || proof.recordKind !== recordKind)) return null;
    if (typeof proof.numerator !== "string" || !/^-?[1-9]\d{0,2047}$/.test(proof.numerator) ||
        typeof proof.denominator !== "string" || !/^[1-9]\d{0,2047}$/.test(proof.denominator)) return null;
    if (proof.fingerprint !== residualFingerprint(owner, id, property, value)) return null;
    const whole = BigInt(value), offset = BigInt(proof.numerator), denominator = BigInt(proof.denominator);
    const twice = offset < 0n ? -2n * offset : 2n * offset;
    if (twice > denominator || twice === denominator && whole % 2n !== 0n) return null;
    return {unit, numerator: String(whole * denominator + offset), denominator: proof.denominator};
  }
  function itemRecord(item, owner, order, state, prior) {
    if (tableItem(item) && Array.isArray(item.widget.state.rows)) fail("A full table needs its guarded native schematic records.");
    if (!item || typeof item.id !== "string" || !item.id || !ITEM_KINDS.has(item.kind)) fail("Invalid editor item identity.");
    const ignored = new Set([...SOURCE_ITEM, "id", "kind", "order"]);
    const out = fields(item, ignored);
    let kind = item.kind;
    if (kind === "offsheet" && out.io === "unspecified") delete out.io;
    if (kind === "imageMarkup") {
      // The markup editor already supplies oriented UV integer coordinates and widths.
      return {...out, kind, id: item.id, ...(order ? {order} : {})};
    }
    if (kind === "textframe") {
      const modes = [item.math === true, object(item.richText), object(item.widget), object(item.calculation), item.role === "frame"];
      if (modes.filter(Boolean).length > 1) fail("A text frame has incompatible notebook content.");
      if (modes[0]) {
        kind = "math";
        out.tex = item.text;
        if (out.size !== undefined) out.em = U.length(out.size).value;
        delete out.size;
        delete out.text;
        delete out.math;
      } else if (modes[1]) kind = "richtext";
      else if (modes[2]) kind = "widget";
      else if (modes[3]) kind = "calculation";
      else if (modes[4]) {
        kind = "frame";
        out.name = item.text;
        delete out.text;
        delete out.role;
      }
    }
    if (kind === "image") {
      if (item.asset) out.asset = imageRef(item.asset);
      else if (state) Object.assign(out, imageAsset(item, state));
      else out.asset = prior?.asset;
      if (!out.asset) fail("The image needs a staged asset.");
      delete out.src;
      delete out.sourceName;
      delete out.file;
    }
    const onResidual = residual(state, owner, item.id, kind);
    let ink;
    if (kind === "inkStroke" && Array.isArray(out.points)) {
      ink = out.points.map(([x, y, pressure]) => {
        if (!Number.isInteger(pressure) || pressure < 0 || pressure > 255) fail("Invalid ink pressure.");
        return [...V.point(x, y, onResidual), pressure];
      });
      delete out.points;
    }
    const hasPoint = kind !== "image" && Number.isFinite(item.x) && Number.isFinite(item.y);
    if (hasPoint) { delete out.x; delete out.y; }
    const widget = kind === "widget" ? out.widget : undefined;
    if (widget !== undefined) delete out.widget;
    const value = V.encode(out, "", [], onResidual);
    if (kind === "frame") validateFrame(value.name, value.w, value.h);
    if (widget !== undefined) value.widget = V.encodeOpaque(widget);
    if (hasPoint) value.at = V.point(item.x, item.y, onResidual);
    if (ink) value.points = ink;
    return {...value, kind, id: item.id, ...(order ? {order} : {})};
  }
  function validateFrame(name, w, h) {
    if (typeof name !== "string" || !name.trim() || name.length > 300 ||
        !Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) fail("Invalid named frame.");
  }
  const omitOrder = new Set(["order"]), omitInk = new Set(["order", "points"]), omitWidget = new Set(["order", "widget"]);
  function itemProjection(record, options) {
    if (record.kind === "imageMarkup") return clone(fields(record, omitOrder));
    const rawInk = record.kind === "inkStroke" && Array.isArray(record.points) ? record.points : null;
    const widget = record.kind === "widget" ? record.widget : undefined;
    const value = V.decodeFields(record, rawInk ? omitInk : widget !== undefined ? omitWidget : omitOrder);
    if (rawInk) value.points = rawInk.map(([x, y, pressure]) => [U.mm(x), U.mm(y), pressure]);
    if (widget !== undefined) value.widget = V.decodeOpaque(widget);
    if (Array.isArray(value.at) && value.at.length === 2 && !Object.hasOwn(value, "x")) {
      [value.x, value.y] = value.at;
      delete value.at;
    }
    if (record.kind === "frame") {
      const {name, ...body} = value;
      validateFrame(name, body.w, body.h);
      return {...body, kind:"textframe", role:"frame", text:name};
    }
    if (record.kind === "math") {
      const {tex, em, ...body} = value;
      return {...body, kind: "textframe", text: tex, math: true, ...(em === undefined ? {} : {size: U.mm(em)})};
    }
    if (["richtext", "widget", "calculation"].includes(record.kind)) return {...value, kind: "textframe", text: value.text ?? ""};
    if (record.kind === "image") {
      value.asset = imageRef(record.asset);
      const src = options.renderAsset?.(value.asset, value.id);
      if (src) value.src = src;
      else if (!options.nativeAssets) value.src = "data:image/png;base64,";
    }
    return value;
  }
  // These arrays contain independently addressable authored or retained geometry.
  const subdocuments = [
    {keys: ["panel", "cells"], kind: "panelCell"},
    {keys: ["drawing", "views"], kind: "drawingView"},
    {keys: ["drawing", "dimensions"], kind: "drawingDimension"},
    {keys: ["bodies3d"], kind: "boardBody"},
    {keys: ["bodyModels"], kind: "modelAlias"},
    {keys: ["stackup", "layers"], kind: "layer"},
    {keys: ["pcbDrawing", "pours"], kind: "copperRegion"},
  ];
  function parentAt(data, keys, create = false) {
    let owner = data;
    for (const key of keys.slice(0, -1)) {
      if (!object(owner[key])) {
        if (!create) return null;
        owner[key] = {};
      }
      owner = owner[key];
    }
    return owner;
  }
  const terminalProjection = new Set(["nativeId","nativeIdOwner"]);
  function memberRecords(data, definitions, owner, allocate, state, blobs, previous) {
    const records = [];
    for (const {keys, kind, side, terminalIdentity} of definitions) {
      const parent = parentAt(data, keys), field = keys.at(-1);
      if (!Array.isArray(parent?.[field]) || !parent[field].length) continue;
      let list = parent[field];
      parent[field] = [];
      if (kind === "modelAlias") list = resolveAliases(list, state, blobs);
      const order = initialOrder(list.length), duplicates = new Map();
      for (const [index, item] of list.entries()) {
        // The row ID is independent of a vendor's terminal, layer or model alias.
        const ownedTerminal = terminalIdentity && (!item.nativeIdOwner || item.nativeIdOwner === owner);
        const nativeId = ownedTerminal && typeof item.nativeId === "string" && item.nativeId ? item.nativeId : undefined;
        const id = allocate(nativeId ?? previous?.(kind, side, item, index));
        const authored = typeof item.id === "string" && item.id ? item.id : null;
        const exact = state?.trackResiduals && !authored ? [] : null;
        const report = authored ? residual(state, owner, authored, kind) : exact ? (...entry) => exact.push(entry) : undefined;
        const value = V.encode(terminalIdentity ? fields(item, terminalProjection) : item, "", [], report);
        if (exact?.length) {
          // The same source leaf has the same address after an independent
          // conversion or a reorder. Only fully identical leaves share a digest.
          const fractions = Object.fromEntries(exact.map(([path, ...amount]) => [JSON.stringify(path), amount]));
          let geometry = value;
          if (kind === "copperRegion" && item.source === "altium" && item.polygon != null) {
            // The editor indexes copper contacts after importing the original rings.
            const {links, ...sourceRegion} = value;
            geometry = sourceRegion;
          }
          const digest = F.sha256(encodeText(F.canonical({geometry, fractions})));
          const occurrence = duplicates.get(digest) ?? 0;
          duplicates.set(digest, occurrence + 1);
          const emit = residual(state, owner, owner, kind);
          for (const [path, ...amount] of exact) emit([...keys, digest, occurrence, ...path], ...amount);
        }
        records.push({kind, id, order: order[index], value});
      }
    }
    return records;
  }
  function priorMembers(file, records = file.records()) {
    const groups = new Map();
    for (const row of records) {
      if (file.isOpaque(row.id)) continue;
      const key = row.kind + "/" + (row.side ?? "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const rows = new Map();
    for (const [key, group] of groups) {
      const orderedRows = group.sort(ordered);
      rows.set(key, {
        byId:new Map(orderedRows.filter(row => typeof row.value?.id === "string").map(row => [row.value.id, row.id])),
        orderedRows,
      });
    }
    return (kind, side, item, index) => {
      const group = rows.get(kind + "/" + (side ?? ""));
      if (typeof item.id === "string") return group?.byId.get(item.id);
      const row = group?.orderedRows[index];
      return row && typeof row.value?.id !== "string" && kind !== "pin" && kind !== "pad" ? row.id : undefined;
    };
  }
  function restoreModel(value, options) {
    if (!value?.model) return;
    const payload = options.modelPayload?.(value.model);
    if (typeof payload?.zlib === "string") value.zlib = payload.zlib;
    else {
      const text = payload?.stepText ?? options.modelText?.(value.model);
      if (typeof text === "string") value.stepText = text;
    }
  }
  function restoreMembers(data, definitions, records, options, ownerId) {
    for (const {keys, kind, terminalIdentity} of definitions) {
      const selected = records.filter(item => item.kind === kind).sort(ordered);
      if (!selected.length) continue;
      const owner = parentAt(data, keys, true);
      owner[keys.at(-1)] = selected.map(record => {
        const value = V.decode(record.value);
        if (kind === "modelAlias") restoreModel(value, options);
        if (terminalIdentity) Object.assign(value,{nativeId:record.id, nativeIdOwner:ownerId});
        return value;
      });
    }
  }
  function sheetSettings(doc) {
    if (doc.kind !== "schematic" || !object(doc.sheet)) return;
    const sheet = {...doc.sheet};
    if (sheet.infinite === false) delete sheet.infinite;
    if (Object.keys(sheet).length) return V.encode(sheet);
  }
  function documentSettings(doc) {
    if (doc.rules != null) fail("Board rules belong to the project rule book. Re-import this design.");
    const omit = new Set([...SOURCE_DOCUMENT, ...LOCAL, "id", "kind", "name", "items", "order"]);
    const data = clone(fields(doc, omit));
    if (doc.kind === "schematic") delete data.sheet;
    if (data.pcbDrawing) {
      delete data.pcbDrawing.pourSignatureVersion;
      delete data.pcbDrawing.pourSignatures;
    }
    return data;
  }
  const documentDefaults = kind => ({grid: kind === "pcb" ? 0.25 : 1.27, outline: [], notes: []});
  function createDocument(doc, options = {}) {
    if (!Object.hasOwn(F.documentSuffix, doc.kind) || typeof doc.id !== "string" || !doc.id || !Array.isArray(doc.items)) fail("Invalid editor document.");
    const {state, blobs} = options, order = initialOrder(doc.items.length);
    const recordId = options.allocate ?? idPool(legacyIds(doc, doc.id));
    const values = documentSettings(doc);
    const outside = memberRecords(values, subdocuments, doc.id, recordId, state, blobs);
    const settingsId = recordId();
    const settingsKind = "documentSettings";
    const settings = {kind: settingsKind, id: settingsId,
      value: V.encode(values, "", [], residual(state, doc.id, doc.id, settingsKind))};
    const items = [], sheet = sheetSettings(doc), unverified = new Set(G.AtriumPourMarker.read(doc.pcbDrawing));
    let header = typed(doc.kind, doc.id, sheet ? {sheet} : {});
    for (const [i,value] of doc.items.entries()) {
      const item = value.id ? value : {...value,id:recordId()};
      const rank = validOrder(item.order) ? item.order : order[i];
      if (tableItem(item)) {
        header = F.withTable(header,true);
        const packed = tableFormat().pack(item,null,retainOrders);
        items.push({...itemRecord(packed.item,doc.id,rank,state),kind:"notebookTable"},...packed.parts);
      } else {
        const row = itemRecord(item,doc.id,rank,state);
        if (row.kind === "polygon" && unverified.has(row.id)) delete row.copperBasis;
        items.push(row);
      }
    }
    return F.create(header,[settings,...outside,...items],readOptions(doc.kind,doc.id));
  }
  function document(file, options = {}, display) {
    const {id, kind} = file.header;
    if (!Object.hasOwn(F.documentSuffix, kind)) fail("Expected a document member.");
    let settings;
    const tableOwners=file.header.requires?.includes(F.tableFeature) ? tableFormat().children(file) : null;
    const members = [], items = [];
    for (const record of file.projectedRecords?.() ?? file.records()) {
      if (file.isOpaque(record.id)) continue;
      if (display) display.add(record);
      if (ITEM_KINDS.has(record.kind) || record.kind === "notebookTable") items.push(record);
      else if (TABLE_ROWS.includes(record.kind)) continue;
      else if (record.kind === "documentSettings") {
        if (settings) fail("Duplicate document settings.");
        settings = record;
      } else members.push(record);
    }
    const result = settings ? V.decode(settings.value) : {};
    if (result.rules != null) fail("Board rules belong to the project rule book. Re-import this design.");
    const header = file.projectedHeader ?? file.header;
    if (kind === "schematic" && header.sheet) result.sheet = V.decode(header.sheet);
    if (members.length) restoreMembers(result, subdocuments, members, options);
    items.sort(ordered);
    if (file.readOnly) result.atriumCompat = compatibility(file);
    return {...documentDefaults(kind), ...result, id, kind,
      name: options.name ?? kind, items: items.map(record => record.kind === "notebookTable"
        ? tableFormat().project(itemProjection({...record,kind:"widget"},options),tableOwners.get(record.id),ordered)
        : itemProjection(record,options))};
  }
  function retainOrders(rows, earlier) {
    const byKind = new Map();
    for (const row of rows) {
      const key = row.kind + "/" + (row.side ?? "");
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key).push(row);
    }
    for (const group of byKind.values()) {
      const anchors = new Array(group.length);
      let right = null, reordered = false;
      for (let index = group.length - 1; index >= 0; index--) {
        anchors[index] = right?.order ?? null;
        const old = earlier.get(group[index].id);
        if (!old?.order) continue;
        if (right !== null && ordered(old, right) >= 0) { reordered = true; break; }
        right = old;
      }
      if (reordered) continue; // An explicit reorder receives fresh evenly spaced order keys.
      let left = "";
      for (const [index, row] of group.entries()) {
        row.order = earlier.get(row.id)?.order ?? (left === anchors[index] ? left : between(left, anchors[index]));
        left = row.order;
      }
    }
  }
  function metadataEdits(base, doc, before) {
    const nextSettings = documentSettings(doc), beforeSettings = before && documentSettings(before);
    if (beforeSettings && sameNativeValue(beforeSettings,nextSettings)) return {rows:[],removed:[]};
    const earlier = new Map();
    const kinds = new Set(subdocuments.map(member => member.kind));
    let current;
    for (const record of base.records()) {
      if (record.kind === "documentSettings") current = record;
      if (kinds.has(record.kind)) earlier.set(record.id, record);
    }
    const claimed = new Set();
    function allocate(preferred) {
      let id = preferred;
      while (!id || claimed.has(id) || id === base.header.id || base.get(id) && !earlier.has(id)) id = newRecordId();
      claimed.add(id);
      return id;
    }
    const projected = current && projectedRecord(base,current.id);
    const saved = projected ? V.decode(projected.value) : {};
    restoreMembers(saved, subdocuments, [...earlier.values()].map(row => projectedRecord(base,row.id,row)), {});
    const visible = beforeSettings ?? {...documentDefaults(doc.kind),...saved};
    const values = retainedValue(saved,visible,nextSettings);
    const prior = priorMembers(base, earlier.values());
    const rows = memberRecords(values, subdocuments, doc.id, allocate, undefined, undefined, prior);
    retainOrders(rows, earlier);
    for (const [index, row] of rows.entries()) {
      const raw = earlier.get(row.id);
      if (!raw) continue;
      const old = projectedRecord(base, row.id, raw);
      rows[index] = retainedValue(raw, {kind:old.kind,id:old.id,order:old.order,value:V.encode(V.decode(old.value))}, row);
    }
    const value = V.encode(values);
    if (current) {
      const id = current.id;
      rows.push(retainedValue(current, {kind:"documentSettings",id,value:V.encode(V.decode(projected.value))},
        {kind:"documentSettings",id,value}));
    } else if (Object.keys(value).length) {
      rows.push({kind:"documentSettings",id:allocate(),value});
    }
    return {rows:rows.filter(row => !sameNativeValue(base.get(row.id),row)),
      removed: [...earlier.keys()].filter(key => !claimed.has(key))};
  }
  const tableEditStale="The saved table changed before the cell edit could be applied.";
  function documentEdits(base, doc, {put = [], remove = [], tableCells = [], settings = false, settingsBefore, copperBases, state} = {}) {
    if (doc && doc.id !== base.header.id || settingsBefore && settingsBefore.id !== base.header.id)
      fail("The edit belongs to a different document.");
    let tail = base.tailOrder;
    const rows = [];
    // A retained basis must not certify known unverified contours in an older reader either.
    // For an item-only save that could restore a removed basis, consult the saved settings.
    let unverified = settings ? new Set(G.AtriumPourMarker.read(doc?.pcbDrawing)) : null;
    const acceptedBases = copperBases?.length ? new Map(copperBases) : null;
    function savedUnverified() {
      for (const row of base.records()) if (row.kind === "documentSettings") {
        const drawing = projectedRecord(base,row.id,row).value?.pcbDrawing;
        return new Set(G.AtriumPourMarker.read(V.decode(drawing)));
      }
      return new Set();
    }
    let count, header;
    const previousTables = () => tableFormat().children(base);
    function updateCount(amount) {
      if (count === undefined) count = base.header.requires?.includes(F.tableFeature) ? previousTables().size : 0;
      count += amount;
    }
    const removed = new Set(remove);
    const editedTables=new Set();
    for(const edit of tableCells){
      const change=!removed.has(edit.id) && !editedTables.has(edit.id) && tableFormat().editCell(base,edit);
      if(!change)fail(tableEditStale);
      editedTables.add(edit.id);
      if(change.put)rows.push(change.put);else removed.add(change.remove);
    }
    for (const id of remove) if (base.get(id)?.kind === "notebookTable") {
      for (const child of previousTables().get(id)?.keys() ?? []) removed.add(child);
      updateCount(-1);
    }
    for (let item of put) {
      if(editedTables.has(item.id))fail(tableEditStale);
      const prior = base.get(item.id), table = tableItem(item), previousTable = prior?.kind === "notebookTable";
      const order = validOrder(item.order) ? item.order : prior ? prior.order : (tail = between(tail));
      if (table || previousTable) {
        const previous = previousTable ? previousTables().get(item.id) : null;
        if (table !== previousTable) updateCount(table ? 1 : -1);
        if (table) {
          const packed = tableFormat().pack(item,previous,retainOrders,true);
          for (const part of packed.parts) rows.push(part);
          for (const id of packed.remove) removed.add(id);
          const owner = {...itemRecord(packed.item,base.header.id,order,null,prior),kind:"notebookTable"};
          if (!prior || F.canonical(owner) !== F.canonical(prior)) rows.push(owner);
          continue;
        }
        for (const id of previous?.keys() ?? []) removed.add(id);
      }
      const inline = !item.asset && item.kind === "image" && /^data:image\/[^,]+,.+/.test(item.src || "");
      const edited = itemRecord(item, base.header.id, order, inline ? state : null, prior);
      let row = edited;
      if (prior && !previousTable && !base.isOpaque(item.id)) {
        const source = projectedRecord(base, item.id);
        const baseline = itemRecord(itemProjection(source, {nativeAssets:true}), base.header.id, prior.order, null, source);
        row = retainedValue(prior, baseline, edited);
      }
      if (row.kind === "polygon" && row.copperBasis) {
        unverified ??= savedUnverified();
        if (unverified?.has(row.id)) {
          row = {...row};
          delete row.copperBasis;
        }
      }
      if (row.kind === "polygon" && acceptedBases?.has(row.id) && !unverified?.has(row.id))
        row = {...row,copperBasis:acceptedBases.get(row.id)};
      rows.push(row);
    }
    remove = [...removed];
    if (settings) {
      // Settings changes are explicit. Ordinary item moves never enter this branch.
      if (!doc) fail("Capture the document settings before saving them.");
      const sheet = sheetSettings(doc);
      const prior = base.header.sheet;
      const exposed = projectedRecord(base, base.header.id, base.header).sheet;
      const baseline = settingsBefore ? sheetSettings(settingsBefore) :
        exposed && sheetSettings({kind:base.header.kind,sheet:V.decode(exposed)});
      if (!sameNativeValue(sheet, baseline)) {
        header = {...base.header};
        const changed = retainedValue(prior ?? absent, baseline ?? absent, sheet ?? absent);
        if (changed !== absent) header.sheet = changed; else delete header.sheet;
      }
      const metadata = metadataEdits(base, doc, settingsBefore);
      if (unverified.size || acceptedBases) {
        const written = new Set(rows.map(row => row.id));
        for (const id of unverified) {
          if (written.has(id) || removed.has(id)) continue;
          const old = base.get(id);
          if (old?.kind !== "polygon" || !old.copperBasis || base.isOpaque(id)) continue;
          const row = {...old};
          delete row.copperBasis;
          rows.push(row);
        }
        for (const [id,basis] of acceptedBases || []) {
          if (written.has(id) || removed.has(id) || unverified.has(id)) continue;
          const old = base.get(id);
          if (old?.kind !== "polygon" || base.isOpaque(id) || sameNativeValue(old.copperBasis,basis)) continue;
          rows.push({...old,copperBasis:basis});
        }
      }
      rows.push(...metadata.rows);
      remove = [...remove, ...metadata.removed];
    }
    if (count !== undefined && !!base.header.requires?.includes(F.tableFeature) !== (count > 0))
      return {put:rows,remove,header:F.withTable(header || base.header,count > 0),featureChange:F.tableFeature};
    return {put:rows, remove, ...(header ? {header} : {})};
  }
  function displayDependencies() {
    const libraries = new Set(), images = new Map();
    return {
      add(row) {
        if (row.kind === "part" && typeof row.def === "string") libraries.add(row.def);
        for (const ref of ownerDependencies(row, {purpose: "display"})) images.set(row.id + "/" + ref.path, ref);
      },
      result() {
        return {libraries: [...libraries].sort(F.compare), assets: [...images.values()].sort((a, b) =>
          F.compare(a.path, b.path) || F.compare(a.ownerId, b.ownerId))};
      },
    };
  }
  function documentDependencies(file, {itemIds} = {}) {
    const display = displayDependencies();
    const rows = itemIds === undefined ? file.records() : Array.from(itemIds, id => file.get(id));
    for (const row of rows) if (row && !file.isOpaque(row.id)) display.add(row);
    return display.result();
  }
  function documentWithDependencies(file, options) {
    const display = displayDependencies();
    const owner = document(file, options, display);
    return {owner, dependencies: display.result()};
  }
  function ownerDependencies(item, {purpose = "save"} = {}) {
    let refs;
    function refer(ref, media) {
      if (!ref) return;
      const asset = assetRef(ref);
      if (media && asset.mediaType !== media) fail("Invalid asset type for its owner.");
      refs ??= new Map();
      const path = assetPath(asset), old = refs.get(path);
      if (old && (old.byteLength !== asset.byteLength || old.mediaType !== asset.mediaType)) fail("Conflicting asset references.");
      refs.set(path, {path, ownerId: item.id, ...asset});
    }
    if (item.kind === "image" && item.asset) {
      refer(imageRef(item.asset));
      if (purpose === "save") refer(item.clip?.source, "application/pdf");
    }
    function cellAssets(content) {
      if(content?.kind==="image")refer(imageRef(content.assetRef));
      if(content?.kind==="rich")refer(content.richText?.font?.assetRef);
    }
    if(item.kind==="tableCell")cellAssets(item.content);
    if(tableItem(item))for(const cell of item.widget.state.cells)cellAssets(cell.content);
    refer(item.font?.assetRef ?? item.font?.asset ?? item.richText?.font?.assetRef ?? item.richText?.font?.asset);
    refer(item.widget?.fallback?.assetRef ?? item.fallback?.assetRef);
    return refs ? [...refs.values()].sort((a, b) => F.compare(a.path, b.path)) : [];
  }
  function binaryMember(value) {
    if (value.mediaType === MEDIA.step) {
      const ref = modelRef(value);
      return {path: modelPath(ref), kind: "model", ...ref};
    }
    const ref = assetRef(value);
    return {path: assetPath(ref), kind: ref.mediaType === MEDIA.snapshot ? "snapshot" : "asset", ...ref};
  }
  function snapshot(file) {
    if (file.header.kind !== "snapshot") fail("Expected a frozen revision root.");
    const members = [], paths = new Set();
    let root;
    for (const row of file.projectedRecords?.() ?? file.records()) {
      if (file.isOpaque(row.id)) continue;
      if (row.kind !== "snapshotMember") {
        if (row.kind !== "snapshotModel") fail("This frozen revision has an unsupported member.");
        continue;
      }
      const {path, fileKind, ownerId} = row;
      F.memberPath(path);
      if (paths.has(F.pathKey(path)) || typeof ownerId !== "string" || !ownerId ||
          !["project", "library", "block", "schematic", "pcb", "drawing", "panel"].includes(fileKind)) {
        fail("Invalid frozen revision member.");
      }
      paths.add(F.pathKey(path));
      const ref = binaryMember(row.asset);
      if (ref.mediaType !== MEDIA.text) fail("Invalid frozen native record payload.");
      const member = {...ref, kind: "archived", logicalPath: path, fileKind, id: ownerId};
      if (fileKind === "project") {
        if (root) fail("A frozen revision has more than one manifest.");
        root = member;
      }
      members.push(member);
    }
    if (!root) fail("A frozen revision needs its manifest.");
    return {root, members};
  }
  function dependencies(file, {archived = false} = {}) {
    const members = file.header.kind === "project" && !archived ? F.manifestMembers(file) : [];
    const seen = new Map(members.map(ref => [ref.path, ref]));
    const register = ref => {
      const previous = seen.get(ref.path);
      if (previous && (previous.kind !== ref.kind || previous.sha256 !== ref.sha256 ||
          previous.byteLength !== ref.byteLength || previous.mediaType !== ref.mediaType)) fail("Conflicting member data " + ref.path + ".");
      if (!previous) { members.push(ref); seen.set(ref.path, ref); }
    };
    function visit(value) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (object(value)) {
        if (Object.hasOwn(value, "mediaType") && Object.hasOwn(value, "sha256") && Object.hasOwn(value, "byteLength")) {
          register(binaryMember(value));
        } else for (const [key, item] of Object.entries(value)) if (!key.startsWith("x-")) visit(item);
      }
    }
    if (file.header.kind === "snapshot") {
      for (const ref of snapshot(file).members) register(ref);
      for (const row of file.records()) if (row.kind === "snapshotModel") visit(row);
    } else {
      visit(file.projectedHeader ?? file.header);
      for (const row of file.projectedRecords?.() ?? file.records()) {
        if (file.isOpaque(row.id)) continue;
        if (row.kind === "release" && (!row.snapshot || assetRef(row.snapshot).mediaType !== MEDIA.snapshot)) {
          fail("A released revision needs its frozen snapshot.");
        }
        visit(row);
      }
    }
    return members.sort((a, b) => F.compare(a.path, b.path));
  }

  const libraryMembers = [
    {keys: ["symbol", "pins"], kind: "pin", terminalIdentity:true},
    {keys: ["symbol", "shapes"], kind: "shape", side: "symbol"},
    {keys: ["footprint", "pads"], kind: "pad", terminalIdentity:true},
    {keys: ["footprint", "shapes"], kind: "shape", side: "footprint"},
    {keys: ["footprint", "bodies3d"], kind: "boardBody"},
    {keys: ["footprint", "bodyModels"], kind: "modelAlias"},
  ];
  function attribution(value) {
    if (!object(value)) return undefined;
    const output = {};
    for (const key of ["credit", "licence", "licenceText"]) if (typeof value[key] === "string") output[key] = value[key];
    for (const key of ["sourceUrl", "licenceUrl"]) {
      if (typeof value[key] === "string" && /^https?:\/\/[^/\s?#@]+(?:[/?#]|$)/i.test(value[key])) output[key] = value[key];
    }
    if (typeof value.modified === "boolean") output.modified = value.modified;
    return Object.keys(output).length ? output : undefined;
  }
  function librarySource(source) {
    const credit = attribution(source);
    const nested = attribution(source?.attribution);
    return nested ? {...credit, attribution: nested} : credit;
  }
  function libraryRows(definition, {state, blobs, allocate = idPool([definition.id]), previous} = {}) {
    const id = definition.id;
    if (typeof id !== "string" || !id) fail("The component definition needs an ID.");
    const data = clone(fields(definition, new Set(["id", "name", "sourceName", "source", "attribution"])));
    for (const key of ["source", "attribution"]) {
      const credit = key === "source" ? librarySource(definition[key]) : attribution(definition[key]);
      if (credit) data[key] = credit;
    }
    if (data.model3d) data.model3d = modelLink(data.model3d, state, blobs);
    if (data.footprint?.model3d) data.footprint.model3d = modelLink(data.footprint.model3d, state, blobs);
    const leaves = [], prior = previous && priorMembers(previous);
    for (const member of libraryMembers) {
      const rows = memberRecords(data, [member], id, allocate, state, blobs, prior);
      leaves.push(...rows.map(row => member.side ? {...row, side: member.side} : row));
    }
    const settingsId = prior?.("librarySettings", undefined, {}, 0);
    const metadata = {kind: "librarySettings", id: allocate(settingsId), value: V.encode(data)};
    return [metadata, ...leaves];
  }
  function createLibrary(definition, options) {
    const {id, name} = definition;
    return F.create(typed("library", id, {name}), libraryRows(definition, options), readOptions("library", id));
  }
  function libraryEdits(base, definition, options) {
    if (definition.id !== base.header.id) fail("The edit belongs to a different library member.");
    const before = libraryRows(library(base), {previous:base});
    const after = libraryRows(definition, {...options, previous:base});
    retainOrders(after.filter(row => row.order !== undefined), base);
    return {...retainedRows(base, before, after),
      ...(definition.name !== base.header.name ? {header:{...base.header,name:definition.name}} : {})};
  }
  function library(file, options = {}) {
    if (file.header.kind !== "library") fail("Expected a library member.");
    const entries = Array.from(file.projectedRecords?.() ?? file.records()).filter(row => !file.isOpaque(row.id));
    const metadata = entries.find(row => row.kind === "librarySettings");
    const result = metadata ? V.decode(metadata.value) : {};
    for (const member of libraryMembers) {
      restoreMembers(result, [member], entries.filter(row => !member.side || row.side === member.side), options, file.header.id);
    }
    for (const target of [result, result.footprint]) restoreModel(target?.model3d, options);
    return {...result, id: file.header.id, name: file.header.name};
  }
  function createBlock(block, id, {state, blobs} = {}) {
    const allocate = idPool([id, ...block.items.map(item => item.id)]), order = initialOrder(block.items.length);
    const metadata = V.encode(fields(block, new Set(["format", "version", "id", "name", "size", "items", "library"])));
    const settings = {kind: "blockSettings", id: allocate(), value: metadata, size: V.encode(block.size, "points")};
    const items = block.items.map((item, index) => itemRecord(item.id ? item : {...item, id: allocate()},
      id, order[index], state));
    const libraryRows = block.library.map(definition => {
      const file = createLibrary(definition, {state, blobs});
      return {kind: "blockLibrary", id: allocate(),
        header: file.header, records: Array.from(file.records())};
    });
    return F.create(typed("block", id, {name: block.name}), [settings, ...items, ...libraryRows], readOptions("block", id));
  }
  function block(file, options = {}) {
    if (file.header.kind !== "block") fail("Expected a layout block.");
    const entries = Array.from(file.projectedRecords?.() ?? file.records()).filter(row => !file.isOpaque(row.id));
    const settings = entries.find(row => row.kind === "blockSettings");
    if (!settings) fail("Missing layout block settings.");
    return {...V.decode(settings.value), format: "atrium-block", version: 1, name: file.header.name,
      size: V.decode(settings.size, "points"),
      items: entries.filter(row => ITEM_KINDS.has(row.kind)).sort(ordered).map(row => itemProjection(row, options)),
      library: entries.filter(row => row.kind === "blockLibrary").map(row => library(F.create(row.header, row.records), options))};
  }

  const PROJECT_LISTS = [["variants", "variant"], ["outputJobs", "outputJob"], ["bomViews", "bomView"],
    ["savedQueries", "savedQuery"], ["savedViews", "savedView"], ["slides", "slide"],
    ["datasheets", "datasheetRef"], ["datasheetAnnotations", "datasheetAnnotation"]];
  const optionalProjectField = name => [...PROJECT_LISTS,...LINK_MAPS].some(([key,kind]) => key === name && F.isOptionalManifestKind(kind));
  function queryRecords() {
    if (!G.AtriumDesignQueryRecord && typeof importScripts === "function") importScripts("../checks/design-query-record.js");
    // @ts-ignore Standalone CommonJS format tests use the same light validator.
    if (!G.AtriumDesignQueryRecord && typeof require === "function") require("../checks/design-query-record.js");
    return G.AtriumDesignQueryRecord;
  }
  function savedQuery(value, id, {reading = false, previous} = {}) {
    const scope = queryRecords();
    const retained = reading || previous && sameNativeValue(previous, value);
    if (id !== value?.id || !scope?.validSaved(value, {allowUnknown:!!retained})) fail("Invalid saved query record.");
    return value;
  }
  const datasheetKind = kind => kind === "datasheetRef" || kind === "datasheetAnnotation";
  function datasheetValue(kind, row, id, reading = false) {
    if (!G.AtriumDatasheetRecord && typeof importScripts === "function") importScripts("../notebook/datasheet-record.js");
    // @ts-ignore Standalone CommonJS format tests use the same light validator.
    if (!G.AtriumDatasheetRecord && typeof require === "function") require("../notebook/datasheet-record.js");
    if (!object(row) || !queryRecords().savedId(id) || !reading && row.id !== id)
      fail("Invalid native " + kind + " identity.");
    const payload = reading ? row : fields(row, new Set(["id"])), data = G.AtriumDatasheetRecord;
    const known = kind === "datasheetRef" ? ["sha256","byteLength","title","version","sourceURL","pageCount","asset"] :
      ["datasheetId","page","region","type","text","points"];
    const value = reading ? Object.fromEntries(Object.entries(payload).filter(([key]) => known.includes(key))) : payload;
    if (!(kind === "datasheetRef" ? data?.validateReference(value) : data?.validateAnnotation(value)))
      fail("Invalid native " + kind + " record.");
    return reading ? {id, ...value} : value;
  }
  const savedViewLimit = 128;
  const LAYER_MODES = new Set(["all", "dim", "single"]);
  const savedViewId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const viewControls = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
  const viewText = (v, size) => typeof v === "string" && v.length > 0 && v.length <= size && !viewControls.test(v);
  const viewFinite = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  const viewPixels = v => Number.isSafeInteger(v) && v >= 1 && v <= 32768;
  const viewIds = (v, max) => Array.isArray(v) && v.length <= max && new Set(v).size === v.length && v.every(s => viewText(s, 512));
  const invalidSavedView = name => { fail("Invalid saved view " + name + "."); };

  function checkSavedView(record, id = record?.id, {reading = false} = {}) {
    if (!object(record) || typeof record.id !== "string" || !savedViewId.test(record.id) || record.id !== id) invalidSavedView("identity");
    if (!viewText(record.name, 200) || !record.name.trim()) invalidSavedView("name");
    if (!viewText(record.documentId, 512)) invalidSavedView("document");
    const {camera, viewport, layers, selection, filter, netHighlight} = record;
    if (!object(camera) || !Array.isArray(camera.center) || camera.center.length !== 2 ||
        !camera.center.every(v => viewFinite(v, -1e9, 1e9)) || !viewFinite(camera.scale, 1e-9, 1000000) ||
        !viewFinite(camera.referenceScale, 1e-9, 1000000) || !viewFinite(camera.rotationRadians, -Math.PI, Math.PI) ||
        typeof camera.flipped !== "boolean") invalidSavedView("camera");
    if (!object(viewport) || !viewPixels(viewport.pixelWidth) || !viewPixels(viewport.pixelHeight)) invalidSavedView("viewport");
    if (layers !== undefined && (!object(layers) || !viewIds(layers.hidden, 4096) ||
        !viewText(layers.active, 512) || !LAYER_MODES.has(layers.mode))) invalidSavedView("layers");
    if (!viewIds(selection, 10000)) invalidSavedView("selection");
    if (netHighlight !== undefined && !viewText(netHighlight, 512)) invalidSavedView("net highlight");
    if (filter !== undefined) {
      if (!object(filter) || typeof filter.mask !== "boolean" || typeof filter.highlight !== "boolean") invalidSavedView("filter");
      const {scope} = filter, Q = queryRecords();
      if (!object(scope) || !(scope.savedQueryId !== undefined ?
        typeof scope.savedQueryId === "string" && savedViewId.test(scope.savedQueryId) && Object.keys(scope).length === 1 :
        Q?.valid(scope, {allowUnknown:reading}) || reading && Q?.isFuture(scope))) invalidSavedView("filter scope");
    }
    return record;
  }

  function savedView(value, id, {reading = false, previous} = {}) {
    const retained = reading || previous?.filter && value?.filter &&
      sameNativeValue(previous.filter, V.encode(value.filter));
    return checkSavedView(value, id, {reading:!!retained});
  }
  const slideLimit = 128;
  const slideNotesControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u;
  function checkSlide(record, id = record?.id, {reading = false, previous} = {}) {
    if (!object(record) || !savedViewId.test(record.id) || record.id !== id) fail("Invalid slide identity.");
    if (!viewText(record.name, 200) || !record.name.trim()) fail("Invalid slide name.");
    if (record.aspect !== "16:9" && record.aspect !== "4:3") fail("Invalid slide aspect.");
    if (typeof record.notes !== "string" || record.notes.length > 16384 || slideNotesControls.test(record.notes)) fail("Invalid slide notes.");
    const source = record.source;
    const keys = source?.kind === "frame" ? ["documentId", "frameId"] :
      source?.kind === "savedView" ? ["savedViewId"] : null;
    const retained = reading || previous?.source && source && sameNativeValue(previous.source, V.encode(source));
    if (!object(source) || !keys || !keys.every(key => key === "savedViewId" ?
        typeof source[key] === "string" && savedViewId.test(source[key]) : viewText(source[key], 512)) ||
        !retained && Object.keys(source).length !== keys.length + 1) fail("Invalid slide source.");
    return record;
  }
  const scopeFields = new Set(["scope", "scope2"]);
  const twoScopeRules = new Set(["clearance", "short", "creepage", "returnPathVia", "parallelSegment", "componentClearance"]);
  function ruleValue(rule, convert, {reading = false, newer = false, previous} = {}) {
    const invalid = key => { throw new F.FormatError("invalid-rule-scope", "Rule " + (rule?.id ?? "?") + " has an invalid native " + key + "."); };
    if (!object(rule) || typeof rule.type !== "string") invalid("type");
    const two = twoScopeRules.has(rule.type);
    if ((two || !newer) && Object.hasOwn(rule, "scope2") !== two) invalid("scope2");
    if (!G.AtriumDesignQueryRecord && typeof importScripts === "function") importScripts("../checks/design-query-record.js");
    // @ts-ignore: CommonJS tests and tools can also load the record on first use.
    if (!G.AtriumDesignQueryRecord && typeof require === "function") require("../checks/design-query-record.js");
    const value = convert(fields(rule, scopeFields)), Q = queryRecords();
    for (const key of two || Object.hasOwn(rule, "scope2") ? ["scope", "scope2"] : ["scope"]) {
      const scope = rule[key];
      if (!Q.valid(scope)) {
        const original = previous?.[key];
        const retained = reading || (scope != null && original != null && F.canonical(scope) === F.canonical(original));
        // A later language cannot run here. Expose its version to the checker and retain the saved value.
        if (!retained || !(Q.isFuture(scope) || newer && Q.valid(scope, {allowUnknown:true}))) invalid(key);
      }
      // Bindings contain UTF-16 offsets and IDs. Future annotations also have their own units and spelling.
      value[key] = Q.copy(scope);
    }
    return value;
  }
  function ruleSetValue(store, convert, options) {
    if (!Array.isArray(store?.sets)) return convert(store);
    const sets = store.sets.map(set => Array.isArray(set?.rules?.list) ? {...set, rules:{...set.rules, list:[]}} : set);
    const value = convert({...store, sets});
    const previousSets = new Map((options.previous?.sets ?? []).map(set => [set.name, set]));
    store.sets.forEach((set, index) => {
      if (!Array.isArray(set?.rules?.list)) return;
      const previous = new Map((previousSets.get(set.name)?.rules?.list ?? []).map(rule => [rule.id, rule]));
      value.sets[index].rules.list = set.rules.list.map((rule, position) => ruleValue(rule,
        source => convert(source, ["sets", index, "rules", "list", position]), {...options, previous:previous.get(rule.id)}));
    });
    return value;
  }
  function outputDefaults(job) {
    if (!Array.isArray(job.outputs)) return job;
    return {...job, outputs:job.outputs.map(output => {
      if (output.kind !== "pdf" || !object(output.options)) return output;
      const options = {...output.options};
      if (options.infiniteLayout === "fit") delete options.infiniteLayout;
      if (options.infiniteScale === 1 || options.infiniteScale === "1") delete options.infiniteScale;
      return {...output, options};
    })};
  }
  function projectRows(project, manifestId, references, state, releases, previous) {
    const allocate = idPool([manifestId, ...references.map(ref => ref.id), ...releases.map(row => row.id)]);
    const rows = [...references, ...releases], skip = new Set([...LOCAL, ...PROJECT_LISTS.map(([name]) => name), ...LINK_MAPS.map(([name]) => name), "id", "name",
      "format", "version", "formatVersion", "documents", "library", "layoutBlocks", "rules", "signals", "review",
      "revisions", "releaseDescriptors", "revisionStore", "blobs", "sourceDrillPlots", "source"]);
    const savedSettings = new Map(), prior = previous && priorMembers(previous);
    if (previous) for (const row of previous.records()) if (row.kind === "projectSetting") savedSettings.set(row.key, row.id);
    function setting(key, value) {
      const kind = "projectSetting", id = allocate(savedSettings.get(key));
      const encode = (source, path = []) => V.encode(source, key, path, residual(state, manifestId, id, kind));
      rows.push({kind, id, key, value:key === "ruleSets" ?
        ruleSetValue(value, encode, {newer:previous?.newer, previous:previous?.get(id)?.value}) : encode(value)});
    }
    function list(kind, entries) {
      if (!Array.isArray(entries)) return;
      if (kind === "savedQuery" && entries.length > queryRecords().savedLimit) fail("Too many saved queries.");
      if (kind === "savedView" && entries.length > savedViewLimit) fail("Too many saved views.");
      if (kind === "slide" && entries.length > slideLimit) fail("Too many slides.");
      const order = initialOrder(entries.length);
      const additions = [];
      for (const [index, entry] of entries.entries()) {
        const id = allocate(prior?.(kind, undefined, entry, index) ?? (typeof entry.id === "string" ? entry.id : undefined));
        if (kind === "savedQuery") savedQuery(entry,id,{previous:previous?.get(id)?.value});
        if (kind === "savedView") savedView(entry, id, {previous:previous?.get(id)?.value});
        if (kind === "slide") checkSlide(entry, id, {previous:previous?.get(id)?.value});
        const encode = value => V.encode(value, "", [], residual(state, manifestId, id, kind));
        const value = kind === "rule" ? ruleValue(entry, encode, {newer:previous?.newer, previous:previous?.get(id)?.value}) :
          datasheetKind(kind) ? V.encodeOpaque(datasheetValue(kind,entry,id)) :
          encode(kind === "outputJob" ? outputDefaults(entry) : entry);
        additions.push({kind, id, ...(datasheetKind(kind) ? {} : {order: order[index]}), value});
      }
      if (previous && !datasheetKind(kind)) retainOrders(additions, previous);
      for (const row of additions) rows.push(row);
    }
    for (const [key, value] of Object.entries(project)) if (!skip.has(key) && value !== undefined) setting(key, value);
    for (const [key, kind] of PROJECT_LISTS) list(kind, project[key]);
    for (const [key, kind] of LINK_MAPS) {
      if (project[key] === undefined) continue;
      if (!object(project[key])) fail("Invalid native " + key + " records.");
      for (const [id, entry] of Object.entries(project[key])) {
        const value = linkValue(kind, entry, id);
        if (allocate(id) !== id) fail("Duplicate native " + kind + " identity.");
        rows.push({kind, id, value:V.encode(value)});
      }
    }
    if (object(project.rules)) {
      setting("rules", fields(project.rules, new Set(["list"])));
      list("rule", project.rules.list);
    }
    if (object(project.signals)) {
      setting("signals", fields(project.signals, new Set(["signals", "tags"])));
      list("signal", project.signals.signals);
      list("tag", project.signals.tags);
    }
    if (object(project.review?.records)) {
      setting("review", fields(project.review, new Set(["records"])));
      const entries = Object.values(project.review.records);
      list("reviewThread", entries.filter(row => row.type === "thread"));
      list("reviewReply", entries.filter(row => row.type === "reply"));
    }
    return rows;
  }
  function createManifest(project, {id = project.id, references = [], releases = [], entryDocument, state, previous} = {}) {
    let header = typed("project", id, {name: project.name, ...(entryDocument ? {entryDocument} : {})});
    if (references.some(r => r.requires?.includes(F.tableFeature))) header = F.withTable(header, true);
    return F.create(header, projectRows(project, id, references, state, releases, previous), readOptions("project", id));
  }
  function manifestEdits(base, project) {
    const references = [], releases = [];
    for (const raw of base.records()) {
      // Membership changes are written separately by the folder engine. Keep their
      // existing bytes and avoid validating them as newly authored manifest rows.
      if (["document", "library", "layoutBlock", "importIndex"].includes(raw.kind)) references.push(raw);
      else if (raw.kind === "release") releases.push(raw);
    }
    const id = base.header.id;
    const metadata = model => projectRows(model, id, references, undefined, releases, base)
      .filter(row => !["document", "library", "layoutBlock", "importIndex", "release"].includes(row.kind));
    const delta = retainedRows(base, metadata(manifest(base).project), metadata(project));
    return {...delta, ...(project.name !== base.header.name ? {header:{...base.header,name:project.name}} : {})};
  }
  function manifest(file) {
    const members = F.manifestMembers(file), lists = new Map(), settings = Object.create(null), releases = [];
    for (const row of file.projectedRecords?.() ?? file.records()) {
      if (file.isOpaque(row.id)) continue;
      if (row.kind === "projectSetting") {
        if (typeof row.key !== "string" || !row.key || Object.hasOwn(settings, row.key)) fail("Duplicate or invalid project setting.");
        settings[row.key] = row.key === "ruleSets" ? ruleSetValue(row.value, source => V.decode(source), {reading:true, newer:file.newer}) : V.decode(row.value, row.key);
      } else if (row.kind === "release") releases.push(row);
      else if (Object.hasOwn(row, "value")) {
        if (!lists.has(row.kind)) lists.set(row.kind, []);
        lists.get(row.kind).push(row);
      }
    }
    const list = kind => (lists.get(kind) ?? []).sort(ordered).map(row => {
      if (kind === "rule") return ruleValue(row.value, V.decode, {reading:true, newer:file.newer});
      if (datasheetKind(kind)) return datasheetValue(kind,V.decodeOpaque(row.value),row.id,true);
      const value = V.decode(row.value);
      if (kind === "savedQuery") return savedQuery(value, row.id, {reading:true});
      if (kind === "savedView") return savedView(value, row.id, {reading:true});
      if (kind === "slide") return checkSlide(value, row.id, {reading:true});
      return value;
    });
    if ((lists.get("slide")?.length ?? 0) > slideLimit) fail("Too many slides.");
    if (Object.hasOwn(settings, "slides")) fail("Reserved native slides setting.");
    const savedQueries = lists.get("savedQuery");
    if (savedQueries && savedQueries.length > queryRecords().savedLimit) fail("Too many saved queries.");
    if ((lists.get("savedView")?.length || 0) > savedViewLimit) fail("Too many saved views.");
    for (const [key, kind] of PROJECT_LISTS) {
      if (F.isOptionalManifestKind(kind) && Object.hasOwn(settings,key)) fail("Reserved native " + key + " setting.");
      if (lists.has(kind)) settings[key] = list(kind);
    }
    for (const [key, kind] of LINK_MAPS) {
      if (Object.hasOwn(settings, key)) fail("Reserved native " + key + " setting.");
      if (lists.has(kind)) settings[key] = Object.fromEntries(lists.get(kind).map(row =>
        [row.id, linkValue(kind, V.decode(row.value), row.id, true)]));
    }
    if (lists.has("rule") && !object(settings.rules)) fail("Native rules need their project rule book.");
    if (settings.rules) settings.rules.list = list("rule");
    if (settings.signals) { settings.signals.signals = list("signal"); settings.signals.tags = list("tag"); }
    if (settings.review) {
      settings.review.records = Object.fromEntries([...list("reviewThread"), ...list("reviewReply")].map(row => [row.id, row]));
    }
    const {id, name, entryDocument} = file.header;
    const project = {...settings, format: "atrium", version: 1, formatVersion: EDITOR_FORMAT, id, name, documents: [], library: []};
    // Projected records use the existing editor model. Its validators need the source
    // compatibility mode, while the single-file interchange stamp remains independent.
    delete project.atriumCompat;
    if (file.readOnly) project.atriumCompat = compatibility(file);
    else if (file.newer) project.atriumCompat = {newer: file.header.formatVersion};
    return {project, members: members.sort(ordered), releases, entryDocument,
      ...(file.readOnly ? {readOnly:true, unsupportedFeatures:file.unsupportedFeatures ?? []} : {})};
  }

  const releaseDescriptors = rows => rows.map(({id, value}) => ({id, name:value?.name, letter:value?.letter}));

  function archiveDesign(project, owner, parentState) {
    adoptSourceCopper(project);
    const frozen = buildFiles(project, {projectId: owner, noReleases: true}, parentState);
    const records = [];
    for (const member of frozen.files) {
      const {file, path} = member;
      records.push({kind: "snapshotMember", id: newRecordId(), path, fileKind: file.header.kind,
        ownerId: file.header.id, asset: attach(parentState, F.serialize(file), MEDIA.text)});
    }
    const snapshot = F.create(typed("snapshot", owner), records, readOptions("snapshot", owner));
    return attach(parentState, F.serialize(snapshot), MEDIA.snapshot);
  }
  function assignMissingIds(project) {
    const assignable = [...project.documents, ...project.library, ...project.documents.flatMap(doc => doc.items ?? [])];
    const hasId = item => typeof item.id === "string" && item.id.length > 0;
    if (assignable.every(hasId)) return;
    const allocate = idPool(assignable.filter(hasId).map(item => item.id));
    for (const item of assignable) if (!hasId(item)) item.id = allocate();
  }
  function assignRuleIds(project) {
    const templates = Array.isArray(project.ruleSets?.sets) ? project.ruleSets.sets : [];
    const lists = [project.rules?.list, ...templates.map(set => set?.rules?.list)];
    if (!lists.some(Array.isArray)) return;
    const uuid = uuidAllocator(), current = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const rule of list) {
        if (!object(rule) || uuid.isV7(rule.id)) continue;
        const earlier = rule.id;
        rule.id = uuid.next();
        if (list !== project.rules?.list || typeof earlier !== "string") continue;
        if (!current.has(earlier)) current.set(earlier, []);
        current.get(earlier).push(rule);
      }
    }
    // Old projects can reuse an ID on separately scoped boards. A waiver's
    // board and rule name disambiguate which authored constraint it refers to.
    for (const doc of project.documents) {
      if (!Array.isArray(doc.drcWaivers)) continue;
      for (const waiver of doc.drcWaivers) {
        const candidates = current.get(waiver?.ruleId)?.filter(rule => (!rule.boards || rule.boards.includes(doc.id)) &&
          !rule.exceptBoards?.includes(doc.id) && (!waiver.rule || waiver.rule === rule.name));
        if (candidates?.length === 1) waiver.ruleId = candidates[0].id;
      }
    }
  }
  function buildFiles(project, options, state, currentCopper = currentCertifiedPours(project)) {
    const claimedIds = new Set();
    for (const owner of [...project.documents, ...project.library]) {
      if (!owner.id || claimedIds.has(owner.id)) fail("Duplicate or missing owner ID.");
      claimedIds.add(owner.id);
      for (const item of owner.items ?? []) if (item.id) {
        if (claimedIds.has(item.id)) fail("Duplicate project object ID.");
        claimedIds.add(item.id);
      }
    }
    const allocate = idPool(claimedIds);
    const id = allocate(options.projectId || project.id);
    const manifestPath = options.manifestPath ? F.portablePath(options.manifestPath) : namePart(project.name, "Project") + ".waffle";
    const pathFor = pathPool([manifestPath]);
    const files = [], references = [];
    const docOrder = initialOrder(project.documents.length), libraryOrder = initialOrder(project.library.length);
    for (const [index, doc] of project.documents.entries()) {
      const suffix = F.documentSuffix[doc.kind];
      if (!suffix || typeof suffix !== "string") fail("Unknown document kind.");
      const path = pathFor("", doc.name, suffix), name = pathStem(path, suffix);
      const file = createDocument(doc, {state, blobs: project.blobs, allocate});
      references.push({kind: "document", id: doc.id, docKind: doc.kind, name, path, order: docOrder[index],
        ...(file.header.requires?.includes(F.tableFeature) ? {requires:[F.tableFeature]} : {})});
      files.push({path, file});
    }
    for (const [index, definition] of project.library.entries()) {
      const path = pathFor("libraries/", definition.name, ".wlib");
      const file = createLibrary(definition, {state, blobs: project.blobs, allocate});
      references.push({kind: "library", id: definition.id, path, order: libraryOrder[index]});
      files.push({path, file});
    }
    const blocks = project.layoutBlocks || [], blockOrder = initialOrder(blocks.length);
    for (const [index, value] of blocks.entries()) {
      const blockId = allocate(value.id);
      const path = pathFor("libraries/", value.name, ".wblock");
      references.push({kind: "layoutBlock", id: blockId, path, order: blockOrder[index]});
      files.push({path, file: createBlock(value, blockId, {state, blobs: project.blobs})});
    }
    for (const ref of options.importIndexes || []) references.push({...ref, kind: "importIndex"});
    const releases = [];
    if (!options.noReleases) for (const value of project.revisions || []) {
      if (!G.AtriumRevisions) fail("Load the revision snapshot reader before saving.");
      const releaseId = allocate(value.id);
      const frozen = G.AtriumRevisions.decode(project.revisionStore, value.root);
      const snapshot = archiveDesign(frozen, newRecordId(), state);
      releases.push({kind: "release", id: releaseId, snapshot, value: V.encode(fields(value, new Set(["root"])))});
    }
    const root = createManifest(project, {id, references, releases, entryDocument: options.entryDocument, state});
    F.manifestMembers(root);
    const result = {manifest: root, manifestPath, files: [{path: manifestPath, file: root}, ...files]};
    certifyCopper(currentCopper, result);
    return result;
  }
  function copperEngine() {
    if (!G.AtriumPolygonPour && typeof importScripts === "function") {
      if (!G.AtriumTranslatorWorkerModules) importScripts("../translator-worker-modules.js");
      importScripts(...G.AtriumTranslatorWorkerModules["polygon-pour"].map(path => "../" + path));
    }
    if (!G.AtriumPolygonPour) fail("Load the copper geometry verifier before saving a filled polygon.");
    return G.AtriumPolygonPour;
  }
  function adoptSourceCopper(project) {
    if (project.documents.some(d => d.pcbDrawing?.sourceFill === true)) copperEngine().adoptSourceCopper(project);
  }
  function currentCertifiedPours(project) {
    // Only a verified import or a committed fill supplies a current input stamp. An
    // ordinary save after moving a track must preserve the old basis, even if stale.
    const current = new Map();
    // Verified source hatches already have per-polygon bases after adoption. Reissue only
    // contour-backed board stamps here. A raw hatch awaiting repair keeps its original stamp.
    const stamped = G.AtriumPCBPours ? project.documents.filter(doc => doc.kind === "pcb" && doc.sourcePourSignature) : [];
    const boards = project.documents.filter(doc => doc.kind === "pcb" && doc.pcbDrawing?.pourSignatures);
    if (!boards.length && !stamped.length) return current;
    const defs = new Map(project.library.map(d => [d.id, d]));
    current.stamps = new Set(stamped.filter(doc => G.AtriumPCBPours.matchesSignature(doc, defs, project)).map(doc => doc.id));
    if (!boards.length) return current;
    const engine = copperEngine();
    for (const board of boards) {
      const verified = new Set(engine.inspectCopper(board, defs, {project}).verified);
      const owners = new Set(board.pcbDrawing.pours?.map(r => r.polygon));
      for (const item of board.items) if (item.sourcePour != null) owners.add(item.sourcePour);
      const ids = board.items.filter(p => p.kind === "polygon" && verified.has(p.id) &&
        board.pcbDrawing.pourSignatures[p.id] && (p.copperBasis || owners.has(p.id))).map(p => p.id);
      current.set(board.id, ids);
    }
    return current;
  }
  function certifyCopper(current, result) {
    if (![...current.values()].some(ids => ids.length) && !current.stamps?.size) return;
    const engine = [...current.values()].some(ids => ids.length) ? copperEngine() : null, native = manifest(result.manifest).project, files = new Map();
    for (const member of result.files) {
      const header = member.file.header;
      if (header.kind === "library") native.library.push(library(member.file));
      if (header.kind === "pcb") files.set(header.id, member);
    }
    const nativeDefs = new Map(native.library.map(d => [d.id, d]));
    const boards = new Map();
    for (const documentId of new Set([...current.keys(), ...(current.stamps || [])])) {
      const board = document(files.get(documentId).file);
      native.documents.push(board); // Inherited rules require the board to belong to this project.
      boards.set(documentId, board);
    }
    for (const documentId of current.stamps || []) {
      const member = files.get(documentId), board = boards.get(documentId);
      const settings = [...member.file.records()].find(row => row.kind === "documentSettings");
      const stamp = G.AtriumPCBPours.signature(board, nativeDefs, native);
      if (!settings || !stamp || stamp === board.sourcePourSignature) continue;
      board.sourcePourSignature = stamp;
      const values = {...V.decode(settings.value), sourcePourSignature: stamp};
      member.file = F.edit(member.file, {put: [{...settings, value: V.encode(values)}]});
    }
    for (const [documentId, ids] of current) {
      const member = files.get(documentId), board = boards.get(documentId);
      if (!ids.length) continue;
      // Physical source dimensions can fall between native nanometres. Establish the
      // retained contour against the same canonical values a fresh reader will see.
      const inputs = engine.polygonSignatures(board, nativeDefs, {project:native});
      const bases = engine.copperBases(board, inputs, ids), put = [];
      for (const [id, basis] of bases) {
        const row = member.file.get(id);
        if (row?.kind === "polygon") put.push({...row, copperBasis:basis});
      }
      if (put.length) member.file = F.edit(member.file, {put});
    }
  }
  function fromEditor(input, options = {}) {
    const translated = input?.format === "atrium" ? null : input?.model;
    let provenance = input?.provenance ?? options.provenance;
    let project = clone(translated ?? input);
    if (project?.format !== "atrium" || project.version !== 1 || !Array.isArray(project.documents) ||
        !Array.isArray(project.library)) fail("Expected a Waffle editor model.");
    assignMissingIds(project);
    adoptSourceCopper(project);
    const credits = new Map(project.library.map(definition => [definition.id, librarySource(definition.source)]));
    if (!translated && G.AtriumTranslatorProvenance) {
      provenance = provenance ? clone(provenance) : {version: 1, notes: []};
      project = G.AtriumTranslatorProvenance.separate(project, provenance);
    }
    for (const item of provenance?.fields || []) {
      if (item.type === "library" && !credits.get(item.id)) credits.set(item.id, librarySource(item.values?.source));
    }
    for (const definition of project.library) {
      const credit = credits.get(definition.id);
      if (credit) definition.source = credit;
    }
    const state = {payloads: new Map(), models: new Map(), residuals: [], modelDiagnostics: [], trackResiduals: options.residuals !== false};
    // The live signature includes rule IDs. Verify it before assigning durable IDs,
    // and certify only those contours against the canonical native records afterward.
    const currentCopper = currentCertifiedPours(project);
    assignRuleIds(project);
    const result = buildFiles(project, options, state, currentCopper);
    const encodeModel = options.encodeModel ?? G.AtriumFormat2Models?.encode;
    const models = [...state.models.values()].map(model =>
      encodeModel ? {...model, bytes: encodeModel(model.raw)} : model);
    return {...result, assets: [...state.payloads.values()], models,
      report: input?.report, provenance, residuals: state.residuals, modelDiagnostics: state.modelDiagnostics};
  }
  function detachImports(project, ids) {
    for (const id of ids) if (project.get(id)?.kind !== "importIndex") fail("Choose a retained import index.");
    return F.edit(project, {remove: ids});
  }

  return Object.freeze({checkSavedView, savedViewLimit, checkSlide, slideLimit, optionalProjectField,
    parse, readOptions, createManifest, createDocument, createLibrary, createBlock, manifest, releaseDescriptors, restoreResidual,
    document, documentWithDependencies, library, block, documentDependencies, ownerDependencies, documentEdits, tableEditStale, libraryEdits, manifestEdits, dependencies, snapshot, fromEditor, detachImports,
    assetRef, assetPath, modelRef, modelPath, pathPool, pathStem, MEDIA});
})();
