"use strict";
// Design › Simulate (lazy). Altium keeps mixed-signal simulation under the schematic's Design »
// Simulate » Mixed Sim, so Waffle does too. The entries drive the bundled SPICE Simulation
// extension (extensions/spice) only through its public commands, by AtriumExtensions.execute:
//   spice.show               open the panel (activates the extension in its sandbox worker)
//   spice.analysis <kind>    choose op | dc | ac | tran
//   spice.run                run the chosen analysis with the panel's settings
// Nothing here reaches into the extension's worker, its storage or its iframe. When the extension
// is disabled, removed or extensions are paused, a dialog explains why and offers to turn it back on.
globalThis.AtriumSimMenu = (() => {
  const ID = "waffle.spice";
  const ANALYSES = {op:"Operating Point", dc:"DC Sweep", ac:"AC Analysis", tran:"Transient Analysis"};
  let host = null;

  // -> "ok" | "paused" | "missing" | "disabled" | "blocked"
  function state(X) {
    if (!X) return "missing";
    if (X.safeMode) return "paused";
    const e = X.list().find(x => x.id === ID);
    if (!e) return "missing";
    if (!e.enabled) return "disabled";
    return e.status === "blocked" ? "blocked" : "ok";
  }
  const TEXT = {
    disabled:["SPICE Simulation is turned off.", "Enable the bundled SPICE Simulation extension to run a test bench on this schematic.", "Enable"],
    paused:["Extensions are paused.", "Simulation runs in the bundled SPICE Simulation extension, and every extension is paused (Tools › Extensions). Resume extensions to simulate.", "Resume Extensions"],
    missing:["SPICE Simulation is not installed.", "This build does not include the SPICE Simulation extension. Open Tools › Extensions to see what is available.", "Open Extensions…"],
    blocked:["SPICE Simulation is blocked.", "The SPICE Simulation extension is waiting for your trust. Review it in Tools › Extensions.", "Open Extensions…"]
  };
  // The empty state: resolves true once the extension can run.
  async function offer(X, why) {
    const [head, body, go] = TEXT[why] || TEXT.missing, C = globalThis.AtriumNavCommon;
    const box = C.el("div", null, "empty-state sim-empty"), h = C.el("p", head, "sim-empty-head");
    box.append(h, C.el("p", body));
    const d = globalThis.AtriumShell.dialog({title:"Simulate", body:[box], className:"sim-dialog", actions:[{label:"Cancel"}, {label:go, primary:true, run:async () => {
      try {
        if (why === "disabled") await X.setEnabled(ID, true);
        else if (why === "paused") X.setSafeMode(false);
        else X.openManager();
      } catch (e) {h.textContent = e.message; return false;}
      return true;
    }}]});
    const r = await d.done;
    return r === go && (why === "disabled" || why === "paused") && state(X) === "ok";
  }
  async function ready() {
    const L = globalThis.AtriumLazy; if (!globalThis.AtriumExtensions && L) await L.need("AtriumExtensions");
    const X = globalThis.AtriumExtensions, why = state(X);
    if (why === "ok") return X;
    return await offer(X, why) ? X : null;
  }
  async function simulate(kind) {
    let X;
    host.info(kind ? "Running " + ANALYSES[kind].toLowerCase() + "…" : "Opening SPICE Simulation…");
    try {X = await ready();} catch (e) {host.info(e.message); return;}
    if (!X) {host.info("Simulation not started."); return;}
    try {
      await X.execute("spice.show");
      if (!kind) {host.info("SPICE Simulation panel open. Choose an analysis and press Run."); return;}
      await X.execute("spice.analysis", kind);
      const r = await X.execute("spice.run");
      host.info(r?.error ? ANALYSES[kind] + ": " + r.error : ANALYSES[kind] + " done" + (r?.points && kind !== "op" ? " · " + r.points + " points" : "") + (r?.warnings ? " · " + r.warnings + " warning" + (r.warnings === 1 ? "" : "s") : "") + ". Results are in the SPICE Simulation panel.");
    } catch (e) {host.info(e.message);}
  }
  function attach(h) {
    host = h;
    host.registerAction("simulate", () => simulate(null));
    host.registerAction("simulate-op", () => simulate("op"));
    host.registerAction("simulate-dc", () => simulate("dc"));
    host.registerAction("simulate-ac", () => simulate("ac"));
    host.registerAction("simulate-tran", () => simulate("tran"));
  }
  globalThis.AtriumNavCommon?.ready(attach);
  return Object.freeze({state, simulate, ANALYSES});
})();
