"use strict";
// Portable widget fallback limits used by both sheet records and extension manifests.
globalThis.AtriumWidgetFallback = (() => {
  const chars = 32768;
  const object = x => !!x && typeof x === "object" && !Array.isArray(x);
  const short = (x,n=512) => typeof x === "string" && x.length <= n;
  function withinBytes(serialized,limit) {
    return serialized.length<=limit && (serialized.length*3<=limit || new TextEncoder().encode(serialized).byteLength<=limit);
  }
  function fallbackOK(x) {
    if (!object(x)) return false;
    if (x.type === "text") return Object.keys(x).every(k=>["type","text"].includes(k)) && short(x.text,chars);
    if (x.type !== "image" || !short(x.alt,2048) || !Object.keys(x).every(k=>["type","assetRef","assetId","alt"].includes(k))) return false;
    const ref=x.assetRef;
    const validRef=object(ref) && Object.keys(ref).every(k=>["sha256","mediaType","byteLength"].includes(k)) && /^[a-f0-9]{64}$/.test(ref.sha256) && /^image\/(?:png|jpeg|webp|heic|heif|gif|svg\+xml)$/.test(ref.mediaType) && Number.isSafeInteger(ref.byteLength) && ref.byteLength>0;
    return ref!=null ? validRef && (!x.assetId || x.assetId===ref.sha256) : /^[a-f0-9]{64}$/.test(x.assetId);
  }
  return Object.freeze({chars,withinBytes,fallbackOK});
})();
