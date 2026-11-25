"use strict";
// Ordered pin-to-pad set difference for library import, health, validation and the symbol wizard.
// The comparison keeps the designators the caller already collected: case stays as written, and a
// repeated entry stays repeated. A blank pad is left out of noPin, which is what validation and the
// wizard already did; import and health pass lists that have already dropped blanks. pinsOf and
// padsOf are the shared import collectors (unique, case kept, blanks and thermal vias omitted).
//
//   pinsOf(def) / padsOf(footprint) -> designators in first-seen order
//   difference(pins, pads)          -> {noPad, noPin}
globalThis.AtriumLibraryPairing = (() => {
  const pinsOf = def => [...new Set((def.symbol?.pins || []).map(p => String(p.number)).filter(Boolean))];
  const padsOf = fp => [...new Set((fp?.pads || []).filter(p => !p.thermalVia).map(p => String(p.number ?? "")).filter(Boolean))];
  function difference(pins, pads) {
    const pinList = [...pins], padList = [...pads], padSet = new Set(padList), pinSet = new Set(pinList);
    return {noPad: pinList.filter(n => !padSet.has(n)), noPin: padList.filter(n => n && !pinSet.has(n))};
  }
  return Object.freeze({pinsOf, padsOf, difference});
})();
