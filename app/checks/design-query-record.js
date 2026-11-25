"use strict";
// The native format can validate and copy a scope without loading the query compiler or calculation UI.
globalThis.AtriumDesignQueryRecord = (() => {
  const languageVersion = 1;
  const sourceLimit = 2000;
  const labels = Object.freeze({
    net: "where net.name =", component: "where component.designator =", netclass: "in class",
    componentclass: "in component class", diffpair: "in pair", diffpairclass: "in pair class",
    layer: "on layer", signal: "in signal", tag: "in tag", xsignal: "in xsignal", xsignalclass: "in xsignal class"
  });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 512;
  const targetIds = new Set(["projectId","docId","itemId","signalId","entityId","pinId","definitionId","instanceId","parameterId","field","kind"]);
  const requiredIds = {project:[], sheet:["docId"], item:["docId","itemId"], signal:["signalId"],
    entity:["entityId"], terminal:["docId","itemId","pinId"]};
  function validTarget(target, allowUnknown) {
    if (!plain(target) || !own(requiredIds, target.scope)) return false;
    for (const [key,value] of Object.entries(target)) {
      if (key === "scope") continue;
      if (targetIds.has(key)) { if (!identifier(value)) return false; }
      else if (key === "detached" || key === "needsRebind") { if (typeof value !== "boolean") return false; }
      else if (!allowUnknown) return false;
    }
    return requiredIds[target.scope].every(key => identifier(target[key]));
  }
  function retiredToken(source) {
    // Skip quoted names, including backslash-escaped delimiters. Reserved spellings cannot be native fields.
    const words = source.replace(/"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)/gs, " ");
    return /\blegacy\s*\.|\bwaffle-filter\s*\/\s*1\b/i.test(words);
  }
  function valid(record, {allowUnknown = false} = {}) {
    if (!plain(record) || record.languageVersion !== languageVersion || typeof record.source !== "string" ||
        !record.source.trim() || record.source.length > sourceLimit || retiredToken(record.source)) return false;
    if (!allowUnknown && Object.keys(record).some(key => !["source", "languageVersion", "bindings"].includes(key))) return false;
    if (!own(record, "bindings")) return true;
    if (!Array.isArray(record.bindings) || record.bindings.length > 600) return false;
    const occurrences = new Set();
    const spans = new Set();
    return record.bindings.every(binding => {
      if (!plain(binding) || !identifier(binding.id) || occurrences.has(binding.id) || !identifier(binding.name) ||
          !Array.isArray(binding.span) || binding.span.length !== 2 || !binding.span.every(Number.isSafeInteger)) return false;
      if (!allowUnknown && Object.keys(binding).some(key => !["id","name","span","target"].includes(key))) return false;
      const [start, end] = binding.span;
      if (start < 0 || end <= start || end > record.source.length || spans.has(start + "/" + end)) return false;
      occurrences.add(binding.id);
      spans.add(start + "/" + end);
      return binding.target == null || validTarget(binding.target, allowUnknown);
    });
  }
  function create(source, bindings) {
    const record = {languageVersion, source};
    if (bindings !== undefined && (!Array.isArray(bindings) || bindings.length)) record.bindings = bindings;
    if (!valid(record)) throw new RangeError("Invalid native query scope.");
    if (record.bindings) record.bindings = JSON.parse(JSON.stringify(record.bindings));
    return record;
  }
  const copy = record => JSON.parse(JSON.stringify(record));
  const quote = value => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  function selector(kind, value) {
    if (kind === "all") return create("object");
    if (!own(labels, kind) || !identifier(value)) throw new RangeError("Unknown or incomplete rule selector.");
    return create("object " + labels[kind] + " " + quote(value));
  }
  function fromSelector(value) {
    if (!value) return selector("all");
    return selector(value.kind, value.value);
  }
  const isAll = scope => valid(scope) && !scope.bindings?.length && /^\s*object\s*$/i.test(scope.source);
  const isFuture = scope => plain(scope) && Number.isSafeInteger(scope.languageVersion) && scope.languageVersion > languageVersion &&
    typeof scope.source === "string" && !!scope.source.trim() && !own(scope,"kind") && !own(scope,"sourceDialect") && !retiredToken(scope.source);
  const savedLimit = 128;
  const savedId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  function validSaved(record, {allowUnknown = false} = {}) {
    if (!plain(record) || !savedId(record.id) || !identifier(record.name) || !record.name.trim() ||
        /[\u0000-\u001f\ud800-\udfff]/u.test(record.name) || !plain(record.scope)) return false;
    const tracked = (value, keys) => Object.keys(value).every(k => keys.includes(k) || allowUnknown);
    if (!tracked(record,["id","name","query","scope","columns"]) || !tracked(record.scope,["documentId","instanceId"])) return false;
    if (own(record.scope,"documentId") && !identifier(record.scope.documentId) ||
        own(record.scope,"instanceId") && (!record.scope.documentId || !identifier(record.scope.instanceId))) return false;
    if (own(record,"columns") && (!Array.isArray(record.columns) || record.columns.length > 48 ||
        !record.columns.every(identifier) || new Set(record.columns).size !== record.columns.length)) return false;
    return valid(record.query,{allowUnknown}) || allowUnknown && isFuture(record.query);
  }
  function references(record, projectId) {
    const query = record?.query ?? record;
    const source = record?.query && {objectId:record.id,kind:"savedQuery"};
    const bindings = valid(query, {allowUnknown:true}) ? query.bindings ?? [] : [];
    const refs = [];
    for (const binding of bindings) {
      const b = binding.target;
      if (!b) continue;
      const objectId = b.itemId ?? b.signalId ?? b.entityId ?? b.definitionId ?? b.docId ?? b.projectId ??
        (b.scope === "project" ? projectId : undefined);
      if (objectId) refs.push({...(source && {source}),target:{projectId:b.projectId ?? projectId,objectId,
        ...(b.docId ? {documentId:b.docId} : {}),...(b.instanceId ? {instanceId:b.instanceId} : {}),
        ...(b.field ? {field:b.field} : {})},bindingId:binding.id});
    }
    const {documentId,instanceId} = source ? record.scope ?? {} : {};
    if (documentId) refs.push({source,target:{projectId,objectId:documentId,documentId,
      ...(instanceId ? {instanceId} : {})}});
    return refs;
  }
  function toSelector(scope) {
    if (!valid(scope) || scope.bindings?.length) return null;
    if (isAll(scope)) return {kind:"all"};
    const text = scope.source.trim();
    for (const [kind, label] of Object.entries(labels)) {
      const prefix = "object " + label + " ";
      if (text.slice(0, prefix.length).toLowerCase() !== prefix) continue;
      const quoted = text.slice(prefix.length);
      if (!/^"(?:[^"\\]|\\["\\])*"$/su.test(quoted)) continue;
      const value = quoted.slice(1, -1).replace(/\\(["\\])/g, "$1");
      if (identifier(value)) return {kind, value};
    }
    return null;
  }
  return Object.freeze({languageVersion, sourceLimit, create, valid, copy, selector, fromSelector, toSelector, isAll, isFuture,
    savedLimit, savedId, validSaved, references});
})();
