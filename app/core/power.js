"use strict";
// AtriumPower: is the window on screen, and should work be spent sparingly?
//   AtriumPower.visible()        false while the page is hidden (another tab, minimised, the app
//                                hidden) or the host reports the window fully occluded
//   AtriumPower.efficient()      Efficiency mode is in effect: Preferences › Energy › Efficiency is
//                                Always, or Automatic while on battery or in Low Power Mode
//   AtriumPower.idle()           !visible() || efficient(): background work that is not needed for
//                                what is on screen should wait (polls back off, previews pause)
//   AtriumPower.state()          {visible, hidden, occluded, lowPower, battery, mode, efficient}
//   AtriumPower.onChange(fn)     fn(state) after any change; returns off()
//   AtriumPower.delay(ms)        an idle debounce: ms, doubled in Efficiency mode
//   AtriumPower.frame(cb)        requestAnimationFrame for decorative animation, at most 30 fps in
//                                Efficiency mode (never use it for input-driven redraws)
//   AtriumPower.mode() / setMode("auto" | "always" | "off")   key general.efficiency (atrium.prefs)
// Only when and how often work runs changes; results never do. Hosts report what the page cannot see:
// the macOS app sends {occluded, lowPower, battery} (NSWindow occlusion, NSProcessInfo Low Power Mode,
// IOKit power source) as the "atrium-power" event and globalThis.__atriumPowerState. Elsewhere
// navigator.getBattery() (Chromium, WebView2) gives battery; WebKitGTK and Safari report neither.
// <html data-efficient> carries Efficiency mode to CSS (decorative motion off, style.css).
globalThis.AtriumPower = (() => {
  const G = globalThis, KEY = "general.efficiency", MODES = Object.freeze(["auto", "always", "off"]), doc = G.document;
  const st = {hidden: doc?.visibilityState === "hidden", occluded: false, lowPower: false, battery: false};
  const fns = new Set();
  let modeNow = null, sig = "", native = false;
  const read = () => { let v; try { v = (G.AtriumPrefs || G.AtriumPref)?.get?.(KEY); } catch { v = null; } return MODES.includes(v) ? v : "auto"; };
  const mode = () => modeNow ??= read();
  const efficient = () => { const m = mode(); return m === "always" || (m === "auto" && (st.lowPower || st.battery)); };
  const visible = () => !st.hidden && !st.occluded;
  const state = () => ({visible: visible(), hidden: st.hidden, occluded: st.occluded, lowPower: st.lowPower, battery: st.battery, mode: mode(), efficient: efficient()});
  function update() {
    const s = state(), k = JSON.stringify(s);
    if (k === sig) return;
    sig = k;
    doc?.documentElement?.toggleAttribute?.("data-efficient", s.efficient);
    for (const f of [...fns]) { try { f(s); } catch (e) { G.console?.error?.(e); } }
  }
  function host(o) {
    if (!o || typeof o !== "object") return;
    native = true;
    for (const k of ["occluded", "lowPower", "battery"]) if (typeof o[k] === "boolean") st[k] = o[k];
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
    // Battery where the engine has it and no host reports power (charging is true on mains and on desktops).
    try {
      G.navigator?.getBattery?.().then(b => { const f = () => { if (!native) { st.battery = b.charging === false; update(); } }; b.addEventListener?.("chargingchange", f); f(); }, () => {});
    } catch { /* no Battery Status API */ }
    // Preferences › Energy: the row, and changes made by import, reset or another window.
    const attach = P => {
      P.on?.(KEY, () => { modeNow = null; update(); });
      P.registerPage?.({id: "energy", title: "Energy", order: 3.3, keywords: "energy efficiency battery power low power mode animation background",
        render(c, api) {
          const g = api.group(c, "Efficiency"), row = api.el("div", "prf-row");
          row.dataset.search = "efficiency energy battery low power mode animation background";
          const label = api.el("label", "prf-label", "Efficiency mode"); label.htmlFor = "prf-energy-efficiency";
          const sel = api.el("select"); sel.id = "prf-energy-efficiency";
          for (const [v, t] of [["auto", "Automatic"], ["always", "Always"], ["off", "Off"]]) { const o = api.el("option", null, t); o.value = v; sel.append(o); }
          sel.value = mode();
          const now = api.el("small", "prf-help"), show = () => { now.textContent = efficient() ? "In effect now." : "Not in effect now."; };
          sel.onchange = () => { setMode(sel.value); show(); };
          const control = api.el("span", "prf-control"); control.append(sel);
          const help = api.el("small", "prf-help", "Automatic limits animation and background work on battery or in Low Power Mode.");
          help.id = "prf-energy-efficiency-help"; now.id = help.id + "-now"; sel.setAttribute("aria-describedby", help.id + " " + now.id);
          row.append(label, control, help, now); g.append(row); show();
        }});
      modeNow = null; update();
    };
    G.addEventListener?.("load", () => { if (G.AtriumPrefs) attach(G.AtriumPrefs); else G.AtriumLazy?.need?.("AtriumPrefs").then(attach, () => {}); }, {once: true});
  }
  update();
  return Object.freeze({key: KEY, modes: MODES, visible, efficient, idle: () => !visible() || efficient(), state, mode, setMode, frame, host,
    delay: ms => efficient() ? ms * 2 : ms,
    onChange(fn) { fns.add(fn); return () => fns.delete(fn); }});
})();
