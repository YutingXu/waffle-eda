"use strict";
// Shared edit targets for the Git and desktop format baselines.
globalThis.WaffleBaselineEdits = (() => {
  const MOVE_MM = 0.127;
  const TRACK_MM = 0.254;
  const LABEL_SUFFIX = "_WAFFLE_BENCH";

  function firstItem(documents, kind, predicate) {
    for (const doc of documents) {
      if (doc.kind !== kind) continue;
      const item = doc.items.find(predicate);
      if (item) return {doc, item};
    }
    return null;
  }

  function trackToAdd(project, boards) {
    const {Atrium, AtriumPCBAppearance} = globalThis;
    const anchor = firstItem(boards, "pcb", item => {
      if (item.kind !== "track" || item.arc || item.teardrop) return false;
      if (AtriumPCBAppearance.index(item.layer ?? "Top") < 0 || !(item.width > 0)) return false;
      return !Atrium.same(item.points.at(-2), item.points.at(-1));
    });
    const doc = anchor?.doc ?? boards[0];
    if (!doc) return null;
    const id = "format-baseline-added-track";
    if (project.library.some(def => def.id === id) || project.documents.some(d => d.id === id || d.items.some(item => item.id === id))) {
      throw Error("The reserved benchmark track ID already exists.");
    }
    const source = anchor?.item;
    const [x, y] = source?.points.at(-1) ?? doc.outline[0] ?? [0, 0];
    const [fromX, fromY] = source?.points.at(-2) ?? [x - 1, y];
    const dx = x - fromX, dy = y - fromY, scale = TRACK_MM / Math.hypot(dx, dy);
    const item = {id, kind: "track", points: [[x, y], [x + dx * scale, y + dy * scale]],
      width: source?.width ?? 0.2, layer: source?.layer ?? "Top", net: source?.net ?? ""};
    return {doc, item, anchor: !!anchor};
  }

  function select(project, {kicadGlobalLabel = false} = {}) {
    const boards = project.documents.filter(doc => doc.kind === "pcb");
    const part = firstItem(boards, "pcb", item => item.kind === "part" && Number.isFinite(item.x) && Number.isFinite(item.y));
    const localLabel = firstItem(project.documents, "schematic", item =>
      item.kind === "netlabel" && item.schPaint?.type !== "port" && item.text.trim());
    // KiCad global net labels import as offsheet connectors. The caller supplies the source format.
    const label = localLabel || (kicadGlobalLabel ? firstItem(project.documents, "schematic", item =>
      item.kind === "offsheet" && item.text?.trim()) : null);
    const track = trackToAdd(project, boards);
    return {part, label, track};
  }

  return Object.freeze({MOVE_MM, TRACK_MM, LABEL_SUFFIX, select});
})();
