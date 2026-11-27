"use strict";

// Pin Preferences › Energy › Efficiency to Off in a Playwright page or context, before the app loads.
// Efficiency mode turns decorative motion off (<html data-efficient>, app/core/power.js), and in the
// default Automatic mode it follows the host's battery. Without this pin, a suite that measures
// transitions or motion fails on a laptop running on battery: every transition reads 0s.
// A suite that sets general.efficiency itself keeps its own value, and other stored preferences stay.
// Every browser from tests/support/playwright.cjs already reports mains power, which keeps Automatic
// off; this pin also holds the mode when a host reports Low Power Mode through __atriumPowerState.
module.exports = function efficiencyOff(target) {
  return target.addInitScript(() => {
    if (window !== window.top) return;
    const key = "atrium.prefs";
    let prefs = null;
    try { prefs = JSON.parse(localStorage.getItem(key)); } catch { prefs = null; }
    if (!prefs || typeof prefs !== "object" || !prefs.values || typeof prefs.values !== "object")
      prefs = {format:"atrium-prefs", version:1, values:{}};
    if (!("general.efficiency" in prefs.values)) prefs.values["general.efficiency"] = "off";
    localStorage.setItem(key, JSON.stringify(prefs));
  });
};
