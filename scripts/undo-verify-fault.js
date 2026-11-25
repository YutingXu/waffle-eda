"use strict";
// An intentional incomplete hint proves that this realm actually enabled strict verification.
// The browser runner loads model and undo-store first. Node and the JSC shim load them here.
if (typeof require === "function") {
  require("../app/core/model.js");
  require("../app/history/undo-store.js");
}
(() => {
  const store = globalThis.AtriumUndoStore, project = Atrium.project("Verification probe");
  const doc = project.documents[0], item = {kind:"junction", id:"omitted", x:0, y:0};
  doc.items.push(item);
  store.mark(project);
  item.x = 1;
  let message = "";
  try { store.record(project, {doc, items:[]}); } catch (e) { message = e.message; }
  if (!message.includes("did not report") || store.stats().missed !== 1)
    throw Error("The incomplete undo hint was not rejected by the runtime.");
  store.reset();
  globalThis.undoVerificationProved = true;
  globalThis.console?.log?.("PASS runtime rejected an intentionally incomplete undo hint");
})();
