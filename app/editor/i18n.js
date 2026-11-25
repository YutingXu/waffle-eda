"use strict";
// AtriumI18n shim: English, {name} only. Lazy i18n-core.js replaces it (docs/translating.md).
globalThis.AtriumI18n = (() => {
  const g = globalThis, en = {}, sc = [], REAL = ""; // i18n-extract: non-English locale ids
  const api = {t: (k, a) => (en[k] ?? k).replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s), text: s => s, locale: () => "en",
    define(o) { for (const k in o) en[k] ??= o[k]; return (k, a) => g.AtriumI18n.t(k, a); }, english: () => ({...en}),
    scope(s, n) { sc.push({selector: s, namespaces: [].concat(n || [])}); }, scopes: () => sc.slice(),
    setLocale: c => g.AtriumLazy.need("AtriumI18nCore").then(I => I.setLocale(c))};
  let p = "system"; try { p = g.AtriumPref.get("general.language", p); } catch {}
  const b = s => s.split("-")[0].toLowerCase();
  if (p != "system" ? p != "en" : (g.navigator?.languages || []).some(l => REAL.split(" ").includes(b(l))))
    g.addEventListener?.("DOMContentLoaded", () => api.setLocale(p).catch(e => console.warn(e)));
  return api;
})();
