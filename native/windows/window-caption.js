// Waffle's own title bar on Windows. The host (native/windows/src/Win/MainWindow.cs) removes the
// system caption and injects this script after the bridge, with the window's state in
// window.__waffleWindowCaptionState. The app bar is the title bar:
//   - its blank space ([data-caption-drag]) moves the window; a double click maximises or restores
//     it and a right click opens the window menu;
//   - the minimise, maximise and close buttons sit at the top right (app/style.css lays out the
//     caption band and keeps the app bar's content clear of them; docs/ui-library.md, Window safe area);
//   - the top edge resizes the window (Windows keeps its own resizing frame on the other edges).
// WebView2 receives the mouse over the whole window, so a press on the caption or the top edge is
// handed back to the host, which starts Windows' own move or size loop (snapping included).
(() => {
  "use strict";
  if (window.top !== window) return;
  const webview = window.chrome?.webview;
  if (!webview) return;
  const post = webview.postMessage.bind(webview);
  const send = (command, edge) => post(JSON.stringify(edge ? {action:"windowCaption", command, edge} : {action:"windowCaption", command}));
  const CAPTION = ".appbar-leading > [data-caption-drag]";
  // Segoe Fluent Icons (Windows 11) and Segoe MDL2 Assets (Windows 10) share these code points.
  const GLYPH = {minimize:"\uE921", maximize:"\uE922", restore:"\uE923", close:"\uE8BB"};
  let state = {maximized:false, active:true, fullScreen:false, ...(window.__waffleWindowCaptionState || {})};
  let maximize = null;

  function apply() {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.atriumNativeTitlebar = "windows";
    root.toggleAttribute("data-window-maximized", !!state.maximized);
    root.toggleAttribute("data-window-inactive", !state.active);
    root.toggleAttribute("data-window-full-screen", !!state.fullScreen);
    if (maximize) {
      maximize.textContent = state.maximized ? GLYPH.restore : GLYPH.maximize;
      maximize.setAttribute("aria-label", state.maximized ? "Restore" : "Maximize");
      maximize.dataset.tooltip = state.maximized ? "Restore Down" : "Maximize";
    }
    return true;
  }
  window.__waffleWindowCaption = next => { state = {...state, ...next}; apply(); };
  // The page's styles key on the root's attributes; set them as soon as the root exists.
  if (!apply()) {
    const wait = new MutationObserver(() => { if (apply()) wait.disconnect(); });
    wait.observe(document, {childList:true});
  }

  function build() {
    if (document.querySelector(".window-caption")) return;
    const caption = document.createElement("div");
    caption.className = "window-caption";
    const controls = document.createElement("div");
    controls.className = "window-controls";
    // In the top layer, as the system controls sit above the page: a modal dialog's backdrop (the
    // launch Start Page's is opaque) never hides them. Under a modal they are inert, so a press on
    // them reaches the backdrop and zoneAt finds the control by position.
    controls.popover = "manual";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Window");
    for (const [command, label] of [["minimize", "Minimize"], ["maximize", "Maximize"], ["close", "Close"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-button";
      button.tabIndex = -1; // as on Windows: the caption buttons are not in the keyboard order (Alt+Space is)
      button.dataset.windowCommand = command;
      button.setAttribute("aria-label", label);
      button.dataset.tooltip = label;
      button.textContent = GLYPH[command];
      if (command === "maximize") maximize = button;
      controls.append(button);
    }
    const edge = document.createElement("div");
    edge.className = "window-resize-edge";
    edge.popover = "manual"; // above the controls, as the resizing border runs over the system caption buttons
    edge.setAttribute("aria-hidden", "true");
    for (const side of ["top-left", "top", "top-right"]) {
      const zone = document.createElement("span");
      zone.dataset.edge = side;
      edge.append(zone);
    }
    caption.append(controls, edge);
    document.body.append(caption);
    raise();
    // A modal dialog opened later joins the top layer above the controls: raise them over it.
    new MutationObserver(records => {
      if (records.some(record => record.target.matches?.("dialog:modal"))) raise();
    }).observe(document.documentElement, {subtree:true, attributeFilter:["open"]});
    apply();
  }
  function raise() {
    for (const layer of document.querySelectorAll(".window-controls, .window-resize-edge")) {
      try {
        if (layer.matches(":popover-open")) layer.hidePopover();
        layer.showPopover();
      } catch {}
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, {once:true});
  else build();

  // The caption's parts, topmost first: the resizing edge lies over the controls and the blank caption.
  const ZONES = [".window-resize-edge > [data-edge]", ".window-controls > [data-window-command]", CAPTION];
  const inside = (r, x, y) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  // The part of the caption under the pointer. A modal dialog's backdrop covers the caption, as it
  // covers the page, but the window stays movable and closable, as under the macOS title bar: a
  // press on the backdrop over a part of the caption goes to that part.
  function zoneAt(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    if (!target.matches(":modal")) {
      for (const selector of ZONES) { const zone = target.closest(selector); if (zone) return {zone, backdrop:false}; }
      return null;
    }
    if (inside(target.getBoundingClientRect(), event.clientX, event.clientY)) return null;
    for (const selector of ZONES) for (const zone of document.querySelectorAll(selector))
      if (inside(zone.getBoundingClientRect(), event.clientX, event.clientY)) return {zone, backdrop:true};
    return null;
  }
  function route(event) {
    if (state.fullScreen) return;
    const hit = zoneAt(event);
    if (!hit) return;
    const {zone, backdrop} = hit, command = zone.dataset.windowCommand, edge = zone.dataset.edge;
    // A caption button pressed directly behaves as a button; the page's own handlers still see it.
    if (command && !backdrop && event.type !== "contextmenu") {
      if (event.type === "mousedown") event.preventDefault(); // keep focus in the editor, as on a system caption button
      if (event.type === "click") send(command);
      return;
    }
    // Everything else on the caption is the window's: the editor and the dialog under it never see it.
    // A pointerdown still reaches the page (it closes open menus) unless it lands on a backdrop; it is
    // never cancelled, which would also cancel the mousedown that starts the move.
    if (event.type === "pointerdown") { if (backdrop) event.stopImmediatePropagation(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "contextmenu") { if (!edge) send("menu"); return; }
    if (event.button !== 0) return;
    if (event.type === "mousedown" && edge) send("resize", edge);
    else if (event.type === "mousedown" && !command) send(event.detail === 2 ? "maximize" : "drag");
    else if (event.type === "click" && command) send(command);
  }
  // Capture phase, on the window: before the editor's and the dialogs' own handlers.
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) addEventListener(type, route, true);
})();
