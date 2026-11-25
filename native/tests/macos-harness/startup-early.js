"use strict";
// Test-only renderer milestones use the web navigation clock. The Swift probe reports
// window-server visibility separately, measured from native process start.
(() => {
  const web = {interactiveMs: null, surfaceMs: null, surface: null, scriptsAtSurface: []};
  const round = value => Math.round(value * 10) / 10;
  const scripts = () => Array.from(document.scripts)
    .filter(script => script.src)
    .map(script => new URL(script.src).pathname.split("/app/").at(-1));
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive") web.interactiveMs = round(performance.now());
  });
  const observed = new MutationObserver(() => {
    const modal = document.querySelector("dialog[open]");
    const host = globalThis.AtriumNavHost;
    const surface = modal?.matches(".sp-dialog") ? "welcome" : modal ? "prompt" :
      host?.isStarter?.() === false ? host.doc().kind : null;
    if (!surface) return;
    web.surface = surface;
    web.surfaceMs = round(performance.now());
    web.scriptsAtSurface = scripts();
    observed.disconnect();
  });
  observed.observe(document, {subtree: true, childList: true, attributeFilter: ["open"]});
  window.__waffleStartupReport = () => ({
    ...web, scriptsIdle: scripts(),
    loadEndMs: round(performance.getEntriesByType("navigation")[0]?.loadEventEnd || 0)
  });
})();
