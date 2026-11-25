"use strict";
globalThis.AtriumPourMarker = (() => {
  // Native 2.0 could retain arbitrary optional drawing metadata under these names.
  // Keep an older owner's value and use a versioned free slot only after a real failure.
  const pourMarker = "wafflePourUnverified", pourMarkerFormat = "waffle.pour-unverified/1";
  const pourMarkerKey = key => key === "pourUnverified" || typeof key === "string" && key.startsWith(pourMarker) && /^wafflePourUnverified(?:[1-9][0-9]*)?$/.test(key);
  function pourOwners(value) {
    if (!Array.isArray(value)) return false;
    const seen = new Set();
    for (const id of value) {
      if (typeof id !== "string" || !id || seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }
  function pourUnverifiedKey(drawing) {
    if (!drawing) return;
    if (pourOwners(drawing.pourUnverified)) return "pourUnverified";
    if (!Object.hasOwn(drawing, "pourUnverified") && !Object.hasOwn(drawing, pourMarker)) return;
    return Object.keys(drawing).find(key => key !== "pourUnverified" && pourMarkerKey(key) &&
      drawing[key]?.format === pourMarkerFormat && pourOwners(drawing[key].owners));
  }
  function pourUnverified(drawing) {
    const key = pourUnverifiedKey(drawing);
    return key === "pourUnverified" ? drawing[key] : key ? drawing[key].owners : undefined;
  }
  function setPourUnverified(drawing, owners) {
    let key = pourUnverifiedKey(drawing);
    if (!owners.length) { if (key) delete drawing[key]; return; }
    if (!key && !Object.hasOwn(drawing, "pourUnverified")) key = "pourUnverified";
    if (!key) {
      key = pourMarker;
      for (let n = 1; Object.hasOwn(drawing, key); n++) key = pourMarker + n;
    }
    drawing[key] = key === "pourUnverified" ? owners : {format:pourMarkerFormat, owners};
  }
  return Object.freeze({isKey:pourMarkerKey,key:pourUnverifiedKey,read:pourUnverified,write:setPourUnverified});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumPourMarker;
