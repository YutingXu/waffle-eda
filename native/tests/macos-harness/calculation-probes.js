"use strict";
// Run in the signed macOS harness with the production file-origin page.
globalThis.__uiProbes = {async run() {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  try {
    const host = globalThis.AtriumNavHost;
    check(location.protocol === "file:", "The calculation test needs the native file origin.");
    check(!globalThis.AtriumCalculations && !globalThis.AtriumCalculationWorkerSource, "Calculation code loaded before demand.");
    const calculations = await AtriumLazy.need("AtriumCalculations");
    check(calculations.stats().started === 0, "A worker started without an evaluation request.");
    const project = host.project(), documentId = host.currentId(), revision = host.revision();
    const args = {queryId: 1, text: "10kΩ || 4.7kΩ", documentId, projectRevision: revision};
    const answer = await calculations.answer(args);
    const snapshot = calculations.evaluateExpressionSnapshot(project, {source:args.text, documentId, revision});
    check(answer?.state === "ready", answer?.message || "No worker Answer.");
    check(answer.display === "3.197 kΩ" && answer.display === snapshot.result.display &&
      answer.result.value === snapshot.result.value, "The file worker differs from the frozen evaluator.");
    const statistics = calculations.stats();
    check(globalThis.AtriumCalculationWorkerSource && statistics.started === 1 && statistics.jobs >= 2 && !statistics.local,
      "The native file page did not use its bundled worker.");
    return "CALC " + JSON.stringify({display:answer.display, value:answer.result.value, worker:statistics});
  } catch (e) {
    return "JSERROR " + e.message + " " + e.stack;
  }
}};
