"use strict";
// Native links carry record identities. A URL can never name a file or grant access.
globalThis.AtriumLinkRecord = (() => {
  const G = globalThis;
  const token = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const uriPattern = new RegExp("^waffle://(" + token + ")/(" + token + ")(?:#(datasheet:page=[1-9][0-9]{0,15}))?$");
  const scanPattern = new RegExp("(?<![\\p{L}\\p{N}_])waffle://" + token + "/" + token +
    "(?:#datasheet:page=[1-9][0-9]{0,15})?(?![\\p{L}\\p{N}_%/#?=&@:+~-])", "gu");
  const idPattern = new RegExp("^" + token + "$");
  const fragmentPattern = /^datasheet:page=([1-9][0-9]{0,15})$/;
  const maxLabel = 160;
  const plain = value => value != null && typeof value === "object" && !Array.isArray(value);
  const id = value => typeof value === "string" && value.length === 36 && idPattern.test(value);
  // Earlier native libraries used opaque row IDs. The anchor's URL still uses its own UUIDv7.
  const terminalIdentity = value => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !/[\p{Cc}\ud800-\udfff]/u.test(value);
  const kind = value => typeof value === "string" && /^[a-z][a-zA-Z0-9-]{0,39}$/.exec(value)?.[0] === value;
  const shortLabel = value => typeof value === "string" ? [...value.trim().replace(/\s+/g, " ")].slice(0, maxLabel).join("") : "";
  const own = (value, key) => Object.hasOwn(value, key);
  const only = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));

  function fragment(value) {
    const match = typeof value === "string" && fragmentPattern.exec(value);
    return !!match && match[0] === value && Number.isSafeInteger(Number(match[1]));
  }
  function address(value) {
    return plain(value) && id(value.projectId) && id(value.objectId) &&
      (!own(value, "fragment") || fragment(value.fragment));
  }
  function parse(uri) {
    const match = typeof uri === "string" && uri.length <= 114 && uriPattern.exec(uri);
    if (!match || match[0] !== uri || match[3] && !fragment(match[3])) return null;
    const [, projectId, objectId, selected] = match;
    return {projectId, objectId, ...(selected && {fragment:selected})};
  }
  function format(value) {
    if (!address(value)) throw Error("Choose a valid Waffle record link.");
    return "waffle://" + value.projectId + "/" + value.objectId + (value.fragment ? "#" + value.fragment : "");
  }
  function extract(text) {
    if (typeof text !== "string") return [];
    const out = new Map();
    for (const match of text.matchAll(scanPattern)) {
      const target = parse(match[0]);
      if (target) out.set(match[0], target);
    }
    return [...out.values()];
  }
  function validSource(source) {
    return only(source, ["objectId", "documentId", "kind"]) && id(source.objectId) &&
      (!own(source, "documentId") || id(source.documentId)) && (!own(source, "kind") || kind(source.kind));
  }
  function validRecord(record) {
    return only(record, ["id", "source", "target", "label"]) && id(record.id) && validSource(record.source) &&
      only(record.target, ["projectId", "objectId", "fragment"]) && address(record.target) &&
      (!own(record, "label") || typeof record.label === "string" && [...record.label].length <= maxLabel);
  }
  function validAnchor(anchor) {
    if (!only(anchor, ["id", "kind", "documentId", "ownerId", "terminal", "terminalId"]) ||
        !id(anchor.id) || !id(anchor.documentId) || !id(anchor.ownerId)) return false;
    if (anchor.kind === "net") return !own(anchor, "terminal") && !own(anchor, "terminalId");
    return anchor.kind === "pin" && typeof anchor.terminal === "string" && anchor.terminal.length > 0 &&
      anchor.terminal.length <= maxLabel && (!own(anchor, "terminalId") || terminalIdentity(anchor.terminalId));
  }
  function authoredRecord(source, target, label, recordId = G.AtriumUUID.next()) {
    const record = {id:recordId, source:{...source}, target:{...target}, ...(shortLabel(label) && {label:shortLabel(label)})};
    if (!validRecord(record)) throw Error("Choose valid source and target records.");
    return record;
  }
  return Object.freeze({parse, format, extract, address, validSource, validRecord, validAnchor, authoredRecord, id, terminalIdentity, shortLabel, fragmentPattern});
})();
