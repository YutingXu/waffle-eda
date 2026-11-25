"use strict";
// File › Preferences › Routing. The Preferences bundle loads this renderer before opening the page.
globalThis.AtriumRoutingPrefs = function renderRoutingPrefs(c, {row, group, el}) {
  const r = group(c, "Interactive routing");
  row(r, "routing.cornerStyle", "Starting corner style", "Last used remembers corner changes for this session.", {options: [["last", "Last used"], ["45", "45°"], ["45arc", "Rounded 45°"], ["90", "90°"], ["90arc", "Rounded 90°"], ["any", "Any angle"]]});
  row(r, "routing.neckDown", "Neck down at pads", "Use the rule’s minimum track width to enter a tight pad.");
  row(r, "routing.jitterTolerance", "Walkaround jitter tolerance", "Higher values stick to one side of obstacles longer.", {unit: "%", step: 10});
  const k = group(c, "Keys while routing");
  const cornerKeys = row(k, "routing.spaceCyclesCorner", "Space cycles corner style", "Swap the flip and cycle keys.", {keywords:"spacebar shift space corner style bend flip"});
  const t = AtriumI18n.define({
    "prefs.routing.key_help": "Default: {flip} flips, {cycle} cycles."
  });
  cornerKeys.closest(".prf-row").querySelector(".prf-help").replaceChildren(
    ...AtriumNavCommon.shortcutParts(t("prefs.routing.key_help"), {flip:"Space", cycle:"Shift+Space"}));
  const s = group(c, "Snapping and feedback");
  row(s, "routing.padEntry", "Pad entry", "Where the track meets a pad.", {options: [["centre", "Pad centre"], ["edge", "Nearest pad edge"], ["any", "Anywhere (no pad snap)"]], keywords: "pad centre center edge entry snap"});
  row(s, "routing.snapLabels", "Name the snap target", "Show the pad, via or track end under the route head.");
  row(s, "routing.cornerGlyph", "Corner style at the head", "Preview corner style and arc radius while routing.");
  const d = group(c, "Dynamic re-route on drag");
  row(d, "routing.dragReroute", "Re-route attached tracks while dragging parts", "Off stretches track ends.", {options: [["on", "On"], ["shift", "On with Shift"], ["off", "Off"]], keywords: "drag move component part reroute re-route rubber band dynamic follow"});
  row(d, "routing.dragRerouteCap", "Live re-route limit", "Route connections beyond this limit when you drop.", {unit: "connections", step: 1, keywords: "cap limit performance connections"});
  row(d, "routing.dragRerouteDepth", "Re-route depth", "Reach back to this distance or the first via or branch.", {unit: "mm", step: .1, keywords: "depth distance anchor"});
  r.append(el("p", "prf-note", "Shoved and glossed copper eases into place and new vias drop in with a ring when Appearance › Animations is Full (or System, unless the system asks for reduced motion). Reduced keeps only the fades (halo, conflict, settle flash); Off shows every change at once."));
};
