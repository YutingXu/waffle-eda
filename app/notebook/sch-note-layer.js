"use strict";

// Resolve once per sheet/view/output. The caller supplies its Notes projection;
// this module never enumerates electrical objects or mutates a project/profile.
globalThis.AtriumSchNoteLayer = (() => {
  function policy(purpose, {layer, view = {}, includeNotes} = {}) {
    if (!["screen", "print", "foreign"].includes(purpose)) throw Error("Unknown Notes output.");
    const screen = purpose === "screen";
    const enabled = screen ? view.visible !== false : includeNotes ?? (purpose === "print" ? layer?.print !== false : true);
    const dimmed = screen && view.routing === true;
    const visible = record => enabled && !(screen && view.hiddenKinds?.has(record.kind));
    return {
      visible, opacity: dimmed ? 0.35 : 1,
      visibleIn(record, parentId = null) {
        if (!visible(record) || record.kind === "notesLayer") return false;
        if (record.kind === "imageMarkup") return !!parentId && record.imageId === parentId;
        if (record.kind === "reviewItem") return !!parentId && record.parentId === parentId;
        return parentId === null;
      },
      hit(record) { return screen && !dimmed && visible(record); },
      minimized(record) { return screen && record.kind === "sticky" && view.minimized?.has(record.id) === true; }
    };
  }
  return Object.freeze({policy});
})();
