"use strict";
// Help › What's New: recent features, each with where to find it and a button that runs it.
// Lazy (index.html registers it for the "whats-new" action); the start page's Learn list links here.
globalThis.AtriumWhatsNew = (() => {
  // [title, what it does, where, action]
  const ITEMS = [
    ["Context menus for every object", "Right-click a component, track, via, pour, room or DRC marker for its own commands; right-click empty canvas to place or change the view.", "Right-click", null, "context-menu"],
    ["Signal Integrity", "Impedance, reflections and crosstalk estimates for the selected nets, from the layer stack.", "Tools › Signal Integrity", "si-analysis"],
    ["Component Stress", "Voltage, current and power derating of each part against its ratings.", "Tools › Component Stress…", "component-stress"],
    ["Timing Vision", "Colours constrained tracks short, OK or long while you route and tune.", "View › Overlays", "timing-vision"],
    ["Constraint Manager", "One grid for net, pair and class constraints, with templates.", "Design › Constraint Manager…", "constraints"],
    ["Rooms and Component Classes", "Group parts into classes and rooms; move, fit and copy room formats.", "Design › Rooms, Design › Classes…", "component-classes"],
    ["Dynamic Connector", "A connector symbol whose pin count you set when you place it.", "Place › Dynamic Connector", "dynamic-connector"],
    ["Live Pours", "Pours repour in the background as you edit.", "Tools › Polygon Pours", "pour-live"],
    ["Via Stitching and Fencing", "Fence tracks, stitch board edges and areas, add return-path vias.", "Tools › Via Stitching", "fence-selected"],
    ["3D Layout", "Orbit the board in 3D. Switch between planning, 2D and 3D from the View menu.", "View › 3D Layout Mode", "view-3d"],
    ["Command Palette", "Every command, document, setting and object in one search box.", "View › Command Palette…", "command-palette"]
  ];
  function open(host) {
    const NC = globalThis.AtriumNavCommon, S = globalThis.AtriumShell, el = NC.el, KM = globalThis.AtriumKeymap, kind = host?.doc?.()?.kind || "pcb";
    const list = el("ul", null, "whats-new-list");
    for (const [title, text, where, action, shortcut = action] of ITEMS) {
      const li = el("li"), hint = shortcut && KM?.hintKey?.(shortcut, kind);
      li.append(el("strong", title), el("span", text + " "));
      // The menu path is a link: it closes this dialog and runs the command.
      if (action) {
        const go = el("button", where, "whats-new-go"); go.type = "button"; go.title = "Open " + title;
        go.onclick = () => { go.closest("dialog")?.close(); setTimeout(() => host?.act?.(action), 0); };
        li.append(go, el("span", hint ? " · " : ""));
      } else li.append(el("span", where + (hint ? " · " : "")));
      if (hint) li.append(AtriumShortcut.render(hint, {variant:"inline"}));
      list.append(li);
    }
    const intro = el("p", "Recent features and where to find them. Every command is also in the Command Palette.", "side-note");
    if (!S?.dialog) {host?.info?.("What's New: " + ITEMS.map(i => i[0]).join(", ")); return null;}
    return S.dialog({title:"What’s New", body:[intro, list], className:"whats-new", actions:[
      {label:"Keyboard Shortcuts", run:() => {host?.act?.("shortcuts");}},
      {label:"Close", primary:true}]});
  }
  globalThis.AtriumNavCommon?.ready?.(host => host.registerAction("whats-new", () => open(host)));
  return Object.freeze({ITEMS, open});
})();
