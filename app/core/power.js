"use strict";
// AtriumPower: is the window on screen, and should work be spent sparingly?
//   AtriumPower.visible()        false while the page is hidden (another tab, minimised, the app
//                                hidden) or the host reports the window fully occluded
//   AtriumPower.efficient()      Efficiency mode is in effect: Preferences › Energy › Efficiency is
//                                Always, or Automatic while the system saves power (lowPower: macOS Low
//                                Power Mode, Windows energy saver, the Linux Power Saver power mode).
//                                Running on battery alone never turns it on.
//   AtriumPower.idle()           !visible() || efficient(): background work that is not needed for
//                                what is on screen should wait (polls back off, previews pause)
//   AtriumPower.state()          {visible, hidden, occluded, lowPower, mode, efficient}
//   AtriumPower.saver()          the power-saving mode Automatic follows here: "mac", "windows", "linux",
//                                or "" in a browser, which reports none (Automatic then stays off)
//   AtriumPower.onChange(fn)     fn(state) after any change; returns off()
//   AtriumPower.delay(ms)        an idle debounce: ms, doubled in Efficiency mode
//   AtriumPower.frame(cb)        requestAnimationFrame for decorative animation, at most 30 fps in
//                                Efficiency mode (never use it for input-driven redraws)
//   AtriumPower.mode() / setMode("auto" | "always" | "off")   key general.efficiency (atrium.prefs)
// Only when and how often work runs changes; results never do. Hosts report what the page cannot see,
// as the "atrium-power" event and globalThis.__atriumPowerState: the macOS app sends {occluded, lowPower}
// (NSWindow occlusion, NSProcessInfo Low Power Mode), the Windows app {lowPower} (energy saver or battery
// saver: GetSystemPowerStatus and the power-saving notifications) and the Linux app {lowPower}
// (GPowerProfileMonitor, power-profiles-daemon's power-saver profile). Whether the computer runs on
// battery is not read: it does not decide anything here.
// <html data-efficient> carries Efficiency mode to CSS (decorative motion off, style.css).
globalThis.AtriumPower = (() => {
  const G = globalThis, KEY = "general.efficiency", MODES = Object.freeze(["auto", "always", "off"]), doc = G.document;
  const st = {hidden: doc?.visibilityState === "hidden", occluded: false, lowPower: false};
  const fns = new Set();
  let modeNow = null, sig = "";
  const read = () => { let v; try { v = (G.AtriumPrefs || G.AtriumPref)?.get?.(KEY); } catch { v = null; } return MODES.includes(v) ? v : "auto"; };
  const mode = () => modeNow ??= read();
  const efficient = () => { const m = mode(); return m === "always" || (m === "auto" && st.lowPower); };
  const visible = () => !st.hidden && !st.occluded;
  // The app's hosts report a power-saving mode (native/bridge.js defines AtriumHost); a browser reports none.
  const saver = () => {
    if (!G.AtriumHost) return "";
    const p = G.navigator?.platform || G.navigator?.userAgent || "";   // platform first: MacIntel, Win32, Linux x86_64
    return /Mac/i.test(p) ? "mac" : /Win/i.test(p) ? "windows" : "linux";
  };
  const AUTO_HELP = {mac: "Automatic limits animation and background work while Low Power Mode is on.",
    windows: "Automatic limits animation and background work while energy saver or battery saver is on.",
    linux: "Automatic limits animation and background work in the Power Saver power mode.",
    "": "Automatic limits animation and background work while the system saves power. A browser does not report that, so here only Always turns it on."};
  const state = () => ({visible: visible(), hidden: st.hidden, occluded: st.occluded, lowPower: st.lowPower, mode: mode(), efficient: efficient()});
  function update() {
    const s = state(), k = JSON.stringify(s);
    if (k === sig) return;
    sig = k;
    doc?.documentElement?.toggleAttribute?.("data-efficient", s.efficient);
    for (const f of [...fns]) { try { f(s); } catch (e) { G.console?.error?.(e); } }
  }
  function host(o) {
    if (!o || typeof o !== "object") return;
    for (const k of ["occluded", "lowPower"]) if (typeof o[k] === "boolean") st[k] = o[k];
    update();
  }
  function setMode(m) {
    modeNow = MODES.includes(m) ? m : "auto";
    try { (G.AtriumPrefs || G.AtriumPref)?.set?.(KEY, modeNow); } catch { /* not stored */ }
    update();
    return modeNow;
  }
  function frame(cb) {
    const raf = G.requestAnimationFrame;
    if (typeof raf !== "function") return setTimeout(() => cb(G.performance?.now?.() ?? Date.now()), 16);
    if (!efficient()) return raf(cb);
    return setTimeout(() => raf(cb), 33 - 17);   // about 30 fps: wait out every other display frame
  }
  if (doc?.addEventListener) {
    doc.addEventListener("visibilitychange", () => { st.hidden = doc.visibilityState === "hidden"; update(); });
    G.addEventListener?.("atrium-power", e => host(e.detail));
    if (G.__atriumPowerState) host(G.__atriumPowerState);
    // Preferences › Energy: the row, and changes made by import, reset or another window.
    const attach = P => {
      P.on?.(KEY, () => { modeNow = null; update(); });
      P.registerPage?.({id: "energy", title: "Energy", order: 3.3, keywords: "energy efficiency power saving low power mode energy saver battery saver power saver animation background",
        render(c, api) {
          const g = api.group(c, "Efficiency"), row = api.el("div", "prf-row");
          row.dataset.search = "efficiency energy power saving low power mode energy saver battery saver power saver animation background";
          const label = api.el("label", "prf-label", "Efficiency mode"); label.htmlFor = "prf-energy-efficiency";
          const sel = api.el("select", "ui-field"); sel.id = "prf-energy-efficiency";
          for (const [v, t] of [["auto", "Automatic"], ["always", "Always"], ["off", "Off"]]) { const o = api.el("option", null, t); o.value = v; sel.append(o); }
          sel.value = mode();
          const now = api.el("small", "prf-help"), show = () => { now.textContent = efficient() ? "In effect now." : "Not in effect now."; };
          sel.onchange = () => { setMode(sel.value); show(); };
          const control = api.el("span", "prf-control"); control.append(sel);
          const help = api.el("small", "prf-help", AUTO_HELP[saver()] || AUTO_HELP[""]);
          help.id = "prf-energy-efficiency-help"; now.id = help.id + "-now"; sel.setAttribute("aria-describedby", help.id + " " + now.id);
          row.append(label, control, help, now); g.append(row); show();
        }});
      modeNow = null; update();
    };
    G.addEventListener?.("load", () => { if (G.AtriumPrefs) attach(G.AtriumPrefs); else G.AtriumLazy?.need?.("AtriumPrefs").then(attach, () => {}); }, {once: true});
  }
  update();
  return Object.freeze({key: KEY, modes: MODES, visible, efficient, idle: () => !visible() || efficient(), state, saver, mode, setMode, frame, host,
    delay: ms => efficient() ? ms * 2 : ms,
    onChange(fn) { fns.add(fn); return () => fns.delete(fn); }});
})();
