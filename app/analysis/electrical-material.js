"use strict";
// Copper resistivity (IEC 60028) and linear derating shared by the analysis tools.
globalThis.AtriumElectricalMaterial = (() => {
  const RHO20 = 1.7241e-5; // Ω·mm, annealed copper at 20 °C
  const ALPHA = 0.00393;   // 1/°C
  const rhoAt = (temperature, reference = RHO20) => reference * (1 + ALPHA * (temperature - 20));
  function deratedPower(rated, ambient, knee, tmax) {
    return ambient <= knee ? rated : ambient >= tmax ? 0 : rated * (tmax - ambient) / (tmax - knee);
  }
  return Object.freeze({RHO20, ALPHA, rhoAt, deratedPower});
})();
