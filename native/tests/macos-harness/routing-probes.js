"use strict";
// Routing-feel probes for the WKWebView harness. Appended after ui-probes.js,
// it boots through the stock probes (none selected), then routes with real AppKit mouse and key events:
// pad snap, a real click starting a route, the status chip, Shift+Space cycling all five corner styles,
// the one-time Space hint (no modal), 2 for a via, Escape committing and one undo removing the route.
// Run (from the repo root; the install folder must be a real path outside /tmp):
//   H=native/tests/macos-harness; I=$PWD/$H/target/routefeel
//   HARNESS_INSTALL=$I $H/build.sh && HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 \
//     HARNESS_PROBES=$PWD/$H/css-audit.js:$PWD/$H/ui-probes.js:$PWD/$H/routing-probes.js HARNESS_WORK=/tmp/atrium-route-wk \
//     $I/WaffleHarness.app/Contents/MacOS/Waffle | grep -E "^(PASS|FAIL|NOTE|RESULT)"
{
  const P = globalThis.__uiProbes, wait = ms => new Promise(r => setTimeout(r, ms));
  const H = () => globalThis.AtriumNavHost, post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  const scr = w => {const b = H().canvas().getBoundingClientRect(), s = H().view().worldToScreen(w); return [s[0] + b.left, s[1] + b.top];};
  const chip = () => document.getElementById("route-feel-chip")?.textContent || "";
  globalThis.__uiProbes = {...P, async run() {
    await P.run("__boot_only__");
    const log = P.log;
    try {
      const tab = [...document.querySelectorAll("#document-tabs [data-tab]")].find(t => t.dataset.kind === "pcb"); tab?.click();
      await P.until(3000, () => H().doc().kind === "pcb");
      await AtriumLazy.need("AtriumRouter");
      log(!!globalThis.AtriumRouteFeel, "route-feel loads with the router");
      const defs = H().defs(), pads = [];
      for (const i of H().doc().items) if (i.kind === "part") for (const p of Atrium.pins(i, defs.get(i.def), "pcb")) pads.push({ref: i.ref, net: i.pinNets?.[p.number] || "", at: p.at});
      const a = pads.find(p => p.ref === "J1" && p.net), mid = [a.at[0] + 4, a.at[1]];
      const v = H().view(); v.restoreCamera({...v.camera(), cx: mid[0], cy: mid[1], scale: 40}); H().redraw();
      H().canvas().focus(); H().act("route"); await wait(300);
      const A = scr(a.at);
      await P.mouse(A[0] - 20, A[1] - 10, {kind: "move"}); await P.mouse(A[0] + 3, A[1] + 2, {kind: "move"}); await P.until(1500, () => AtriumRouteFeel.debug().snap.kind === "pad");
      // AppKit delivers mouseMoved only to the key window; the harness window is not key, so hover
      // cannot be probed here (Chrome covers it: scripts/perf-route.py and the routing probes).
      if (P.seen.some(e => e.type === "pointermove")) log(AtriumRouteFeel.debug().snap.kind === "pad", "hovering a pad snaps to its centre before the first click", AtriumRouteFeel.debug().snap);
      else await post("note", {text: "hover not probed: mouseMoved does not reach a window that is not key"});
      await P.mouse(A[0] + 3, A[1] + 2); await wait(150);
      log(!!H().liveRoute(), "a real click on the pad starts a route", document.getElementById("status")?.textContent);
      const B = scr([a.at[0] + 3, a.at[1]]);
      for (let k = 1; k <= 10; k++) {await P.mouse(A[0] + (B[0] - A[0]) * k / 10, A[1] + (B[1] - A[1]) * k / 10, {kind: "move"});}
      await wait(100);
      log(/45°/.test(chip()), "status chip shows the corner style", chip());
      const seen = [];
      for (let k = 0; k < 5; k++) {await P.key(" ", ["shift"]); await wait(80); seen.push(chip().split(" · ")[0]);}
      log(seen.join("|") === "45° with arc|90°|90° with arc|Any angle|45°", "Shift+Space cycles 45°, 45° arc, 90°, 90° arc, any angle", seen);
      await post("shot", {name: "routefeel-corner"});
      await P.key(" "); await wait(150);
      log(!!document.querySelector(".route-feel-hint"), "the first Space offers the Space-cycles preference without a modal", document.querySelector(".route-feel-hint")?.textContent);
      log(!document.querySelector("dialog[open]"), "no dialog opened");
      await P.key("2"); await wait(200);
      log((H().liveRoute()?.preview?.vias?.length || 0) === 1, "2 drops a via", H().liveRoute()?.preview?.vias?.length);
      const n0 = H().doc().items.length;
      await P.key("Escape"); await wait(300);
      const n1 = H().doc().items.length;
      log(n1 > n0 && !H().liveRoute(), "Escape commits the route", {n0, n1});
      await P.key("z", ["cmd"]); await wait(300);
      if (H().doc().items.length !== n0) {await post("note", {text: "Cmd+Z goes to the native Edit menu in the harness; using the Undo action"}); H().act("undo"); await wait(300);}
      log(H().doc().items.length === n0, "one undo removes the whole route", {n0, after: H().doc().items.length});
      await post("shot", {name: "routefeel-after"});
    } catch (e) {log(false, "routing probe ran", String(e?.stack || e).slice(0, 400));}
    return {passed: 0, failed: 0};
  }};
}
