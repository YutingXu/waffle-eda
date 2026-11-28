"use strict";

// Build and focus a tool group only after its first explicit opening gesture (active-bar.js).
// A group comes from GROUPS, from a drawing (AtriumDrawing.toolGroups) or from AtriumBars (bars.js):
// a user's own group, the "⋯" overflow, or a provided group such as the notebook's Widgets.
// Choosing an item runs it and makes it the button's face (sticky flyouts, bars.js).
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
  const G = globalThis, D = G.document;
  let fly = null, owner = null;
  const kind = () => D.body.dataset.kind || "schematic";
  // The rows of a built-in group for a document kind: [{id, label}].
  function rows(key, k) {
    const group = GROUPS[key] || (k === "drawing" && G.AtriumDrawing?.toolGroups?.[key]);
    return group ? group.filter(([, , scope]) => !scope || scope === k).map(([id, label]) => ({id, label})) : null;
  }
  function close(refocus = true, instant = false) {
    if (!fly) return;
    const f = fly, surface = G.AtriumSurfaceMotion;
    fly = null;
    if (surface && f.isConnected) surface.popover(f, false, {instant, done:() => f.remove()});
    else f.remove();
    owner?.setAttribute("aria-expanded", "false");
    owner?.removeAttribute("aria-controls");
    if (refocus) owner?.focus();
    owner = null;
  }
  function open(button) {
    const switching = !!fly?.isConnected;
    close(false, true);
    if (!button.dataset.toolGroup) return null;
    const menu = fly = D.createElement("div"), k = kind();
    menu.id = "active-bar-flyout";
    owner = button; button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-controls", menu.id);
    const list = G.AtriumBars?.flyout(button, k) ?? rows(button.dataset.toolGroup, k);
    Promise.resolve(list).then(items => {
      if (fly !== menu) return;
      if (!items?.length || !button.isConnected || !button.getClientRects().length || G.AtriumPower?.visible?.() === false) {close(false); return;}
      show(menu, button, items, k, switching);
    }, e => { if (fly === menu) { close(false); G.AtriumNavHost?.info(e.message); } });
    return menu;
  }
  function run(row) {
    if (row.run) return row.run();
    if (G.AtriumNavHost) AtriumNavHost.executeKey(row.id); else G.dispatchEvent(new CustomEvent("atrium-command", {detail:row.id}));
  }
  function show(fly, button, list, kind, switching) {
    const C = G.AtriumNavCommon, K = G.AtriumKeymap;
    fly.className = "nav-menu nav-flyout"; G.AtriumWorkbench?.wholePixels(fly);
    fly.setAttribute("role", "menu");
    fly.setAttribute("aria-label", (button.getAttribute("aria-label") || "Tools") + " tools");
    const items = [];
    for (const row of list) {
      if (row.sep) { fly.append(C.el("hr")); continue; }
      const b = C.el("button", null, "nav-menu-item"); b.type = "button"; b.tabIndex = -1; b.setAttribute("role", "menuitem");
      b.append(C.el("span", row.label));
      b.setAttribute("aria-label", row.label);
      const key = K?.hintKey(row.id, kind);
      if (key) {
        b.setAttribute("aria-description", K.display(key, true));
        C.shortcutBadge(b, key);
      }
      b.onclick = () => {
        close();
        try { run(row); } finally { G.AtriumBars?.choose(button, row, kind); }
      };
      fly.append(b); items.push(b);
    }
    fly.addEventListener("keydown", e => {
      const at = items.indexOf(D.activeElement), step = {ArrowDown:1, ArrowUp:-1}[e.key];
      if (step) {e.preventDefault(); e.stopPropagation(); items[(at + step + items.length) % items.length]?.focus(); return;}
      if (e.key === "Home" || e.key === "End") {e.preventDefault(); e.stopPropagation(); (e.key === "Home" ? items[0] : items.at(-1))?.focus(); return;}
      if (e.key === "Tab") {e.stopPropagation(); close(); return;}
      if (e.key === "Escape" || e.key === "ArrowLeft") {e.preventDefault(); e.stopPropagation(); close(); return;}
      e.stopPropagation();
    });
    fly.addEventListener("focusout", e => {if (fly.isConnected && !fly.contains(e.relatedTarget)) close(false);});
    fly.addEventListener("mousedown", e => e.preventDefault());
    (D.getElementById("workbench") || D.body).append(fly);
    const r = button.getBoundingClientRect(), f = fly.getBoundingClientRect(), up = innerHeight - f.height - 4;
    fly.style.left = Math.max(4, Math.min(r.left, innerWidth - f.width - 4)) + "px";
    // Under the button, or raised to fit; a menu taller than the window hangs from the button and
    // scrolls, as the other long menus do (AtriumContextMenu.fitMenu, lazy).
    fly.style.top = (up < 4 ? r.bottom + 4 : Math.min(r.bottom + 4, up)) + "px";
    const CM = G.AtriumContextMenu;
    if (CM) CM.fitMenu(fly); else G.AtriumLazy?.need("AtriumContextMenu").then(m => { if (fly.isConnected) m.fitMenu(fly); }, () => {});
    G.AtriumSurfaceMotion?.popover(fly, true, {instant:switching});
    items[0]?.focus();
  }
  // A flyout closes when a click or focus lands elsewhere, or when its button goes away (the
  // notebook switched off under the Widgets flyout, a kind change, a re-drawn bar).
  D.addEventListener("keydown", e => {
    if (fly && !fly.isConnected && ["Escape", "Tab", "ArrowLeft"].includes(e.key)) {e.preventDefault(); e.stopPropagation(); close();}
  }, true);
  const outside = e => {if (fly && !fly.contains(e.target) && !owner?.contains(e.target)) close(false);};
  for (const t of ["pointerdown", "focusin"]) D.addEventListener(t, outside, true);
  const gone = () => {if (fly && (!owner?.isConnected || !owner.getClientRects().length)) close(false);};
  G.AtriumLabs?.onChange?.(() => setTimeout(gone));
  new MutationObserver(() => setTimeout(gone)).observe(D.body, {attributes:true, attributeFilter:["data-kind"]});
  return {open, close, show, rows, GROUPS, isOpen: () => !!fly, owner: () => owner};
})();
