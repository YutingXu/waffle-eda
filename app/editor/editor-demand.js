"use strict";

// A live editor view brings its rendering, editing and status services online once.
// Home can open Preferences and the library independently of these services.
globalThis.AtriumEditorDemand = (() => {
  function attach(host, loader) {
    const d = globalThis.document, requested = new Set();
    const boardModules = [...loader.board(), "AtriumCanvasFast", "AtriumConnectivityLive", "AtriumDRCView"];
    let boardRequested = false;
    const visible = () => d.visibilityState !== "hidden" && globalThis.AtriumPower?.visible?.() !== false;
    const demand = name => {
      if (requested.has(name)) return;
      requested.add(name);
      loader.need(name).catch(() => {
        requested.delete(name);
        if (boardModules.includes(name)) boardRequested = false;
      });
    };
    // Generated menu commands may have a user binding even before Search opens.
    const keys = globalThis.AtriumKeymap;
    let restoringShortcuts;
    const menuShortcuts = () => {
      const labs = globalThis.AtriumLabs, signal = labs?.notebookSignal();
      if (signal?.aborted || restoringShortcuts && !restoringShortcuts.signal?.aborted ||
          !keys?.unregisteredBindings?.().some(id => /^(?:menu|power):/.test(id))) return;
      const restore = restoringShortcuts = {signal};
      loader.need("AtriumPalettePersonal").then(P => {if (!signal?.aborted) P.restoreShortcuts();})
        .catch(() => {}).finally(() => {if (restoringShortcuts === restore) restoringShortcuts = null;});
    };
    keys?.onChange(menuShortcuts);
    globalThis.AtriumLabs?.onChange(enabled => {if (enabled) menuShortcuts(); else loader.cancelPrefetch();});
    menuShortcuts();
    let lastDoc, lastProject, stopHint;
    const geometry = new WeakMap();
    function prepareCanvasGeometry(project) {
      const idle = globalThis.AtriumIdle;
      if (!idle || !host.prepareBoardGeometry) return;
      for (const root of host.canvasGeometryRoots?.() || []) {
        if (!host.hasBoardArtwork(root) || geometry.get(root) === project) continue;
        geometry.set(root, project);
        const active = () => visible() && !host.isStarter?.() && host.project() === project &&
          host.canvasGeometryRoots().includes(root) && host.hasBoardArtwork(root);
        // The first frame uses the physical primitive producer directly. Index its committed view after that frame.
        idle.afterFrame(() => idle.idle(async () => {
          try {
            const view = active() && await host.prepareBoardGeometry(root);
            if (view && active()) {
              if (root.kind === "panel") globalThis.AtriumPanel?.bindGeometry?.(root, view);
              host.redraw(true);
              return;
            }
          } catch (error) { globalThis.console?.error?.(error); }
          if (geometry.get(root) === project) geometry.delete(root);
        }));
      }
    }
    function currentView() {
      if (!visible()) return;
      const p = host.project(), view = host.doc();
      if (!view || !p) return;
      prepareCanvasGeometry(p);
      if (p.multichannel) demand("AtriumMultichannel");
      if (!requested.has("AtriumSyncStatus") && p.documents.some(x => x.kind === "pcb") && p.documents.some(x => x.kind === "schematic"))
        demand("AtriumSyncStatus");
      const visibleKind = kind => view.kind === kind || host.panes?.().some(pane => host.docById?.(pane.docId)?.kind === kind);
      if (!requested.has("AtriumCanvasBoardBatches") && visibleKind("pcb") && p.documents.some(d => globalThis.AtriumCanvas?.needsBoardBatches(d))) demand("AtriumCanvasBoardBatches");
      if (!boardRequested && visibleKind("pcb")) {
        boardRequested = true;
        for (const name of boardModules) demand(name);
      }
      // Schematic sheets use the same retained artwork (selection and edit frames repaint only the
      // damaged boxes), so a project opened straight onto a sheet does not repaint whole sheets.
      if (!requested.has("AtriumCanvasFast") && visibleKind("schematic")) demand("AtriumCanvasFast");
      if (visibleKind("schematic")) demand("AtriumConnectionPreview");
      if (!requested.has("AtriumDrawing") && visibleKind("drawing")) demand("AtriumDrawing");
      if (view === lastDoc && p === lastProject) return;
      if (p !== lastProject && !requested.has("AtriumMultichannel") && p.documents.some(s => s.kind === "schematic" && s.items?.some(i => i.kind === "sheetsymbol")))
        demand("AtriumMultichannel");
      lastDoc = view;
      lastProject = p;
      for (const name of ["AtriumUndoStore", "AtriumCamera", "AtriumMotion", "AtriumVSKeys", "AtriumDocTabs", "AtriumTabOverflow", "AtriumGuides", "AtriumInsightsUI"]) demand(name);
    }
    function hint(event) {
      const control = event.target?.closest?.("[data-action]");
      if (!control || (event.relatedTarget?.nodeType && control.contains(event.relatedTarget))) return;
      stopHint?.();
      if (event.type === "pointerout" || event.type === "focusout" || !visible() || globalThis.AtriumPower?.efficient?.()) return;
      const action = control.dataset.action;
      if (["bom", "library-panel", "footprint-wizard", "symbol-wizard", "command-palette"].includes(action))
        stopHint = loader.prefetch(loader.forAction(action, host.doc()?.kind) || []);
      else if (globalThis.AtriumSchObjects?.handles(action)) stopHint = loader.prefetch("AtriumSchObjectTools");
    }
    for (const type of ["pointerover", "pointerout", "focusin", "focusout"]) d.addEventListener(type, hint);
    const change = () => { loader.cancelPrefetch(); currentView(); };
    host.on?.("change", change);
    host.on?.("replace", change);
    host.on?.("document", change);
    host.on?.("panes", change);
    host.on?.("pane-revealed", () => prepareCanvasGeometry(host.project()));
    globalThis.AtriumPower?.onChange?.(currentView);
    d.addEventListener("visibilitychange", currentView);
    currentView();
  }
  return {attach};
})();
