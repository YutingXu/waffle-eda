"use strict";
// Inspect native rule scopes without loading the query compiler.
globalThis.AtriumRuleScopeDemand = (book,domain,{detached=false}={}) => {
  if (!book) return false;
  if (book.version===1) return domain!=="schematic" && Object.keys(book.nets || {}).length>0;
  if (!Array.isArray(book.list)) return false;
  const sets=Array.isArray(book.ruleSets) ? book.ruleSets : [];
  const disabled=detached ? null : new Set(sets.filter(s=>s?.enabled===false && typeof s.name==="string").map(s=>s.name.toLowerCase()));
  const all=globalThis.AtriumDesignQueryRecord?.isAll, object=/^\s*object\s*$/i;
  const simple=s=>!s || s.kind==="all" || (all ? all(s) : detached ? object.test(s.source || "") :
    s.languageVersion===1 && !s.bindings?.length && typeof s.source==="string" && object.test(s.source));
  return book.list.some(r=>{
    if (!r || r.enabled===false) return false;
    if (!detached) {
      const erc=/^erc[A-Z]/.test(r.type);
      if (domain && (domain==="schematic")!==erc) return false;
      if (!erc && (r.severity==="off" || disabled.has(String(r.set || "default").toLowerCase()))) return false;
    }
    return !simple(r.scope) || !simple(r.scope2);
  });
};
if (typeof module !== "undefined") module.exports = globalThis.AtriumRuleScopeDemand;
