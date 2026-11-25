"use strict";

// Build and focus a tool group only after its first explicit opening gesture.
globalThis.AtriumActiveBarMenu = (() => {
  // Rows in each tool group: [action, label, scope?]
  const GROUPS = {
    select:[["select", "Select"], ["pan", "Pan"], ["move-object", "Move Object"], ["select-all", "Select All"], ["deselect", "Deselect All"]],
    library:[["library", "Component"], ["via", "Via", "pcb"], ["polygon-pour", "Polygon Pour", "pcb"], ["label", "String", "pcb"], ["logo", "Graphic / Logo from Image…", "pcb"],
      ["via-fence", "Via Fencing…", "pcb"], ["junction", "Junction", "schematic"], ["label", "Net Label", "schematic"],
      ["sch-power", "Power Port", "schematic"], ["sch-port", "Port", "schematic"], ["sch-text", "Text String…", "schematic"]],
    route:[["route", "Interactive Routing", "pcb"], ["route-diffpair", "Interactive Differential Pair Routing", "pcb"], ["length-tune", "Interactive Length Tuning", "pcb"],
      ["length-tune-pair", "Interactive Diff Pair Length Tuning", "pcb"], ["length-tune-skew", "Diff Pair Skew Tuning", "pcb"], ["autoroute-net", "Auto Route » Net…", "pcb"],
      ["fanout", "Auto Route » Fanout…", "pcb"], ["route", "Wire", "schematic"], ["split-wire", "Split Wire", "schematic"]],
    measure:[["measure", "Measure Distance"], ["goto-location", "Jump to Location…"], ["goto-object", "Jump to Object…"]]
  };
  function show(fly, button, kind, close, switching) {
    const key = button.dataset.toolGroup;
    const group = GROUPS[key] || (kind === "drawing" && globalThis.AtriumDrawing?.toolGroups?.[key]);
    if (!group) {close(false); return;}
    const C = globalThis.AtriumNavCommon, K = globalThis.AtriumKeymap;
    fly.className = "nav-menu nav-flyout"; globalThis.AtriumWorkbench?.wholePixels(fly);
    fly.setAttribute("role", "menu");
    fly.setAttribute("aria-label", (button.getAttribute("aria-label") || "Tools") + " tools");
    const items = [];
    for (const [action, label, scope] of group) {
      if (scope && scope !== kind) continue;
      const b = C.el("button", null, "nav-menu-item"); b.type = "button"; b.tabIndex = -1; b.setAttribute("role", "menuitem");
      b.append(C.el("span", label));
      b.setAttribute("aria-label", label);
      const key = K?.hintKey(action, kind);
      if (key) {
        b.setAttribute("aria-description", K.display(key, true));
        C.shortcutBadge(b, key);
      }
      b.onclick = () => {close(); globalThis.AtriumNavHost ? AtriumNavHost.executeKey(action) : globalThis.dispatchEvent(new CustomEvent("atrium-command", {detail:action}));};
      fly.append(b); items.push(b);
    }
    fly.addEventListener("keydown", e => {
      const at = items.indexOf(document.activeElement), step = {ArrowDown:1, ArrowUp:-1}[e.key];
      if (step) {e.preventDefault(); e.stopPropagation(); items[(at + step + items.length) % items.length]?.focus(); return;}
      if (e.key === "Home" || e.key === "End") {e.preventDefault(); e.stopPropagation(); (e.key === "Home" ? items[0] : items.at(-1))?.focus(); return;}
      if (e.key === "Tab") {e.stopPropagation(); close(); return;}
      if (e.key === "Escape" || e.key === "ArrowLeft") {e.preventDefault(); e.stopPropagation(); close(); return;}
      e.stopPropagation();
    });
    fly.addEventListener("focusout", e => {if (fly.isConnected && !fly.contains(e.relatedTarget)) close(false);});
    fly.addEventListener("mousedown", e => e.preventDefault());
    (document.getElementById("workbench") || document.body).append(fly);
    const r = button.getBoundingClientRect(), f = fly.getBoundingClientRect();
    fly.style.left = Math.max(4, Math.min(r.left, innerWidth - f.width - 4)) + "px";
    fly.style.top = Math.min(r.bottom + 4, innerHeight - f.height - 4) + "px";
    globalThis.AtriumSurfaceMotion?.popover(fly, true, {instant:switching});
    items[0]?.focus();
  }
  return {show, GROUPS};
})();
