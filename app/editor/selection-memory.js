"use strict";
// AtriumSelectionMemory: Altium's Selection Memory as RTS control groups (lazy).
//
//   Mod+1…9        store the selection in memory N (an empty selection clears it)
//   Mod+Shift+1…9  add the selection to memory N
//   Alt+1…9        recall memory N (select its objects); recall it again within 400 ms to fly the
//                  camera to the group, as a double-tapped control group does in a strategy game
//   Window › Panels › Selection Memory lists the groups with Select, Fly, Store, Add and Clear.
//
// Plain 1…9 stay free: 1, 2 and 3 are Altium's board planning, 2D and 3D view keys, and 2, 3 and 4
// are routing keys. Memories hold object IDs per document and persist in this browser (bounded).
globalThis.AtriumSelectionMemory = (() => {
  const STORE = "atrium.selmem.v1", SLOTS = 9, MAX_IDS = 20000, MAX_DOCS = 64, TAP_MS = 400;
  const host = () => globalThis.AtriumNavHost;
  let mem = load(), panel = null, lastTap = null;

  // ---------------------------------------------------------------- model (pure on `mem`)
  function load() {
    try {
      const o = JSON.parse(globalThis.localStorage?.getItem(STORE) || "{}"), out = {};
      for (const [doc, slots] of Object.entries(o && typeof o === "object" ? o : {})) {
        if (!slots || typeof slots !== "object") continue;
        const s = {};
        for (const [n, ids] of Object.entries(slots)) if (+n >= 1 && +n <= SLOTS && Array.isArray(ids)) s[n] = ids.filter(x => typeof x === "string").slice(0, MAX_IDS);
        out[doc] = s;
      }
      return out;
    } catch { return {}; }
  }
  function save() {
    const ids = Object.keys(mem);
    if (ids.length > MAX_DOCS) for (const k of ids.slice(0, ids.length - MAX_DOCS)) delete mem[k];
    try { globalThis.localStorage?.setItem(STORE, JSON.stringify(mem)); } catch {}
  }
  const slot = (doc, n) => mem[doc]?.[n] || [];
  function put(doc, n, ids) {
    const s = mem[doc] || {};
    if (ids.length) s[n] = [...new Set(ids)].slice(0, MAX_IDS); else delete s[n];
    delete mem[doc]; if (Object.keys(s).length) mem[doc] = s;
    save(); render();
  }
  // IDs that still exist in the document (deleted objects drop out quietly).
  const alive = (d, ids) => { const have = new Set(d.items.map(i => i.id)); return ids.filter(id => have.has(id)); };

  // ---------------------------------------------------------------- actions
  function store(n, add) {
    const H = host(); if (!H?.doc) return;
    const d = H.doc(), sel = H.selection();
    if (!sel.length && !add) { put(d.id, n, []); H.info?.("Selection memory " + n + " cleared."); return; }
    if (!sel.length) { H.info?.("Select objects first, then add them to memory " + n + "."); return; }
    const ids = add ? [...alive(d, slot(d.id, n)), ...sel] : sel;
    put(d.id, n, ids);
    H.info?.((add ? "Added to" : "Stored in") + " selection memory " + n + ": " + count(slot(d.id, n).length) + "." + shortcutText("selmem-recall-" + n, " recalls it."));
  }
  function recall(n) {
    const H = host(); if (!H?.doc) return;
    const d = H.doc(), ids = alive(d, slot(d.id, n)), now = Date.now();
    const twice = lastTap && lastTap.n === n && lastTap.doc === d.id && now - lastTap.t < TAP_MS;
    lastTap = {n, doc: d.id, t: now};
    if (!ids.length) { H.info?.("Selection memory " + n + " is empty." + shortcutText("selmem-store-" + n, " stores the selection.")); return; }
    H.select(ids, ids[0]);
    if (twice) { flyTo(d, ids); lastTap = null; H.info?.("Selection memory " + n + ": " + count(ids.length) + " in view."); }
    else H.info?.("Selection memory " + n + ": " + count(ids.length) + " selected. Again to fly there.");
  }
  function boxOf(d, ids) {
    const H = host(), C = globalThis.AtriumNavCommon, set = new Set(ids);
    let box = null;
    for (const i of d.items) if (set.has(i.id)) { const b = C?.itemBox?.(d, H.defs(), i); if (b) box = box ? C.union(box, b) : b; }
    return box;
  }
  function flyTo(d, ids) {
    const H = host(), box = boxOf(d, ids), c = H?.canvas?.(); if (!box || !c) return;
    const cam = globalThis.AtriumNavCommon.cameraFor(box, c.clientWidth || 800, c.clientHeight || 600, H.view().camera(), {margin: .35, maxFactor: 16});
    if (globalThis.AtriumCamera?.flyTo) { AtriumCamera.settle?.(); AtriumCamera.flyTo(cam); } else { H.view().restoreCamera({...H.view().camera(), ...cam}); H.redraw(); }
  }
  const count = n => n + (n === 1 ? " object" : " objects");
  function key(id) { return globalThis.AtriumKeymap?.hintKey(id, host()?.doc?.()?.kind); }

  // ---------------------------------------------------------------- panel
  function summary(d, ids) {
    const kinds = new Map(), set = new Set(ids);
    for (const i of d.items) if (set.has(i.id)) kinds.set(i.kind, (kinds.get(i.kind) || 0) + 1);
    return [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => n + " " + k + (n === 1 ? "" : "s")).join(", ");
  }
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(document, tag, cls, text); }
  function shortcutText(id, suffix) {
    const visual = globalThis.AtriumKeymap?.display(key(id));
    return visual ? " " + visual + suffix : "";
  }
  function btn(text, title, fn, disabled, binding, suffix) { const b = el("button", "sm-btn ui-button", text); b.type = "button"; b.dataset.size = "sm"; b.setAttribute("aria-label", title); globalThis.AtriumNavCommon?.shortcutTitle(b, title, binding, suffix); b.onclick = fn; b.disabled = !!disabled; return b; }
  function build() {
    panel = el("div", "cam-panel sm-panel ui-popover"); panel.dataset.anchor = "right";
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-labelledby", "sm-title");
    const head = el("div", "cam-head"), title = el("span", "cam-title", "Selection Memory"); title.id = "sm-title"; head.append(title);
    const close = el("button", "ui-button ui-close vc-close", "×"); close.type = "button"; close.dataset.variant = "quiet"; close.dataset.size = "sm"; globalThis.AtriumNavCommon?.shortcutTitle(close, "Close", "Escape"); close.setAttribute("aria-label", "Close Selection Memory"); close.onclick = () => show(false);
    head.append(close);
    const body = el("div", "sm-body"), foot = el("p", "sm-foot");
    panel.append(head, body, foot);
    panel.addEventListener("keydown", e => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); show(false); } });
    document.body.append(panel);
  }
  function render() {
    if (!panel || panel.hidden) return;
    const H = host(), d = H?.doc?.(); if (!d) return;
    const body = panel.querySelector(".sm-body"), sel = H.selection().length;
    body.replaceChildren();
    for (let n = 1; n <= SLOTS; n++) {
      const ids = alive(d, slot(d.id, n)), row = el("div", "sm-row" + (ids.length ? "" : " empty"));
      const shortcut = el("span", "sm-key"); shortcut.append(AtriumShortcut.render(String(n)));
      row.append(shortcut);
      const text = el("span", "sm-text", ids.length ? count(ids.length) : "Empty");
      if (ids.length) text.title = summary(d, ids);
      row.append(text,
        btn("Select", "Select memory " + n, () => recall(n), !ids.length, key("selmem-recall-" + n)),
        btn("Fly", "Fly the camera to memory " + n, () => flyTo(d, ids), !ids.length, key("selmem-recall-" + n), " twice"),
        btn("Store", "Store the selection in memory " + n, () => store(n, false), !sel, key("selmem-store-" + n)),
        btn("Add", "Add the selection to memory " + n, () => store(n, true), !sel, key("selmem-add-" + n)),
        btn("Clear", "Clear memory " + n, () => put(d.id, n, []), !ids.length));
      body.append(row);
    }
    panel.querySelector(".sm-foot").textContent = sel ? count(sel) + " selected." : "Select objects, then Store.";
  }
  function show(on = panel?.hidden !== false) {
    if (on && !panel) build();
    if (panel) {
      const surface = globalThis.AtriumSurfaceMotion;
      if (surface) surface.popover(panel, on);
      else panel.hidden = !on;
    }
    globalThis.AtriumNavCommon?.setChecked?.("selection-memory", !!on);
    if (on) { render(); panel.querySelector("button:not(:disabled)")?.focus({preventScroll: true}); }
    else host()?.canvas?.()?.focus?.();
  }

  function attach(H) {
    H.registerAction("selection-memory", () => show(!panel || panel.hidden));
    for (let n = 1; n <= SLOTS; n++) {
      H.registerAction("selmem-store-" + n, () => store(n, false));
      H.registerAction("selmem-add-" + n, () => store(n, true));
      H.registerAction("selmem-recall-" + n, () => recall(n));
    }
    for (const t of ["selection", "document", "change"]) H.on(t, render);
    globalThis.AtriumKeymap?.onChange(render);
  }
  if (globalThis.AtriumNavCommon?.ready && globalThis.document) globalThis.AtriumNavCommon.ready(attach);

  return {store, recall, show, slot, put, isOpen: () => !!panel && !panel.hidden, _reset() { mem = {}; save(); }};
})();
