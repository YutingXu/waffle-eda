"use strict";
// AtriumWelcome: the start page's "Get set up" walkthrough (start-page.js mounts it in its right column).
// It opens by itself the first time the start page shows (no saved state yet), and again from the
// start page's "Customise Waffle" link or Help › Customise Waffle. Each step is a card with live
// controls and a preview; every choice applies at once through the module that owns the setting
// (AtriumKeymap, AtriumTheme, AtriumPrefs, AtriumCamera, the renderer and efficiency modules) and is
// undone by choosing the old value again. Nothing changes until the user picks something.
//
//   AtriumWelcome.firstLaunch()      -> true while no walkthrough state is saved
//   AtriumWelcome.state()            -> {v, seen, closed, done:{id:true}, skipped:{id:true}, from, open}
//   AtriumWelcome.steps()            -> ids of the steps this build offers (feature-detected)
//   AtriumWelcome.progress()         -> {done, total}
//   AtriumWelcome.value(id)          -> the step's current setting (no writes)
//   AtriumWelcome.choose(id, value, part?)   apply a choice and mark the step done
//   AtriumWelcome.skip(id)           AtriumWelcome.close()   AtriumWelcome.reset()
//   AtriumWelcome.mount(container, startPage) / unmount()    the panel (DOM only)
//
// State: "atrium.welcome.v1" in localStorage (registered as per-viewer state in prefs-storage.js,
// so Reset all settings clears it and an export leaves it out). The default fab preset for new
// projects is the preference "start.fabPreset" (File › New and the start page's blank project apply it; start-page.js withFab).
globalThis.AtriumWelcome = (() => {
  const G = globalThis, doc = G.document, STORE = "atrium.welcome.v1";
  const ls = () => { try { return G.localStorage || null; } catch { return null; } };
  const obj = o => (o && typeof o === "object" && !Array.isArray(o) ? {...o} : {});
  const str = v => (typeof v === "string" ? v : "");

  // ------------------------------------------------------------------ state
  function read() {
    try {
      const v = JSON.parse(ls()?.getItem(STORE) || "null");
      if (v && v.v === 1) return {v: 1, seen: !!v.seen, closed: !!v.closed, done: obj(v.done), skipped: obj(v.skipped), from: str(v.from), open: str(v.open)};
    } catch {}
    return null;
  }
  const state = () => read() || {v: 1, seen: false, closed: false, done: {}, skipped: {}, from: "", open: ""};
  function write(patch) {
    const s = {...state(), ...patch};
    try { ls()?.setItem(STORE, JSON.stringify(s)); } catch {}
    return s;
  }
  const firstLaunch = () => !read();
  function mark(id, how) {
    const s = state();
    if (how === "done") { s.done[id] = true; delete s.skipped[id]; } else if (!s.done[id]) s.skipped[id] = true;
    return write({done: s.done, skipped: s.skipped});
  }
  const reset = () => { try { ls()?.removeItem(STORE); } catch {} };

  // ------------------------------------------------------------------ settings, read through their owners
  const P = () => G.AtriumPrefs, T = () => G.AtriumTheme, K = () => G.AtriumKeymap, L = () => G.AtriumLazy;
  function pget(key, fallback) {
    let v;
    try { v = P() ? P().get(key) : G.AtriumPref?.get?.(key, fallback); } catch {}
    return v === undefined || v === null ? fallback : v;
  }
  function pset(key, value) {
    if (P()) return P().set(key, value);
    return G.AtriumPref?.set?.(key, value);
  }
  // Mouse settings belong to camera.js (it validates them); before it loads they go to the store it reads.
  const mouseSet = (key, value) => (G.AtriumCamera?.setPref ? G.AtriumCamera.setPref(key, value) : pset(key, value));
  const lazyHas = name => { try { return !!L()?.modules?.().includes(name); } catch { return false; } };

  // Renderer (canvas-gpu-pref.js) and Efficiency (the power module): shown only when they exist.
  function renderer() {
    const X = G.AtriumCanvasGPUPref;
    if (!X || typeof X.key !== "string") return null;
    const modes = Array.isArray(X.modes) && X.modes.length ? X.modes.map(String) : ["auto", "gpu", "2d"];
    return {key: X.key, modes, get: () => { const v = pget(X.key, modes[0]); return modes.includes(v) ? v : modes[0]; },
      set: v => pset(X.key, v), describe: () => { try { return String(X.describe?.() || ""); } catch { return ""; } }};
  }
  function efficiency() {
    const X = G.AtriumPower;
    if (!X) return null;
    let modes = typeof X.modes === "function" ? X.modes() : X.modes ?? X.MODES;
    // power.js documents mode() / setMode("auto" | "always" | "off") without exporting the list.
    if ((!Array.isArray(modes) || !modes.length) && typeof X.mode === "function" && typeof X.setMode === "function") modes = ["auto", "always", "off"];
    if (!Array.isArray(modes) || !modes.length) return null;
    const titles = {};
    modes = modes.map(m => { if (m && typeof m === "object") { titles[m.id] = m.title || m.label; return String(m.id); } return String(m); });
    const key = [X.key, X.KEY, X.prefKey, X.PREF_KEY].find(k => typeof k === "string" && k);
    const setter = typeof X.setMode === "function" ? v => X.setMode(v) : key ? v => pset(key, v) : null;
    if (!setter) return null;
    const get = () => {
      let v;
      try { v = typeof X.mode === "function" ? X.mode() : key ? pget(key) : undefined; } catch {}
      return modes.includes(v) ? v : modes[0];
    };
    // The power-saving mode Automatic follows here (power.js saver()): "mac", "windows", "linux", "" in a browser.
    const saver = () => { try { return typeof X.saver === "function" ? String(X.saver() || "") : null; } catch { return null; } };
    return {key: key || "", modes, titles, get, set: setter, saver};
  }
  // Locales other than the pseudo-locale (i18n-core.js; the eager shim knows only English).
  function languages() {
    let list = [];
    try { list = (G.AtriumI18nCore?.available?.() || G.AtriumI18n?.available?.() || []).filter(l => !l.pseudo); } catch {}
    return list;
  }

  // ------------------------------------------------------------------ steps
  // Coming from: a key preset and the wheel behaviour in one choice; each stays adjustable on its own.
  const FROM = Object.freeze({
    altium: {keys: "altium", wheel: "altium"}, kicad: {keys: "kicad", wheel: "zoom"}, allegro: {keys: "allegro", wheel: "zoom"},
    eagle: {keys: "modern", wheel: "zoom"}, new: {keys: "altium", wheel: "zoom"}
  });
  const FROM_ORDER = ["altium", "kicad", "allegro", "eagle", "new"];
  const UNITS = ["mm", "mil"];
  const PCB_GRIDS = {mm: [.05, .1, .25, .5, 1], mil: [.0254, .127, .254, .635, 1.27]};
  const SCH_GRIDS = [.635, 1.27, 2.54];
  const MOTIONS = ["system", "full", "reduce", "off"];
  const STEPS = [
    {id: "from", available: () => !!K()?.setPreset},
    {id: "theme", available: () => !!T()?.set},
    {id: "units", available: () => true},
    {id: "mouse", available: () => true},
    {id: "motion", available: () => !!T()?.set},
    {id: "performance", available: () => !!(renderer() || efficiency())},
    {id: "fab", available: () => !!(G.AtriumFabPresets || lazyHas("AtriumFabPresets"))},
    {id: "ai", available: () => true},
    {id: "language", available: () => languages().length > 1}
  ];
  const steps = () => STEPS.filter(s => { try { return s.available(); } catch { return false; } }).map(s => s.id);
  function progress() {
    const ids = steps(), s = state();
    return {done: ids.filter(id => s.done[id]).length, skipped: ids.filter(id => s.skipped[id] && !s.done[id]).length, total: ids.length};
  }
  const theme = () => { try { return T()?.get?.() || {}; } catch { return {}; } };
  // The current setting of a step (or of one part of it), never writing anything.
  function value(id, part) {
    switch (id) {
      case "from": return part === "keys" ? K()?.preset?.() || "altium" : part === "wheel" ? pget("mouse.wheel", "zoom") : state().from;
      case "theme": { const t = theme(); return part === "accent" ? t.accent || "" : t.followSystem ? "system" : t.preset || "dark"; }
      case "units": return part === "pcbGrid" ? pget("pcb.grid", .25) : part === "schGrid" ? pget("schematic.grid", 1.27) : pget("general.units", "mm");
      case "mouse": return part === "zoomAt" ? pget("mouse.zoomAt", "pointer") : part === "invertZoom" ? !!pget("mouse.invertZoom", false) : pget("mouse.wheel", "zoom");
      case "motion": return theme().motion || "system";
      case "performance": return part === "efficiency" ? efficiency()?.get() : renderer()?.get();
      case "fab": return str(pget("start.fabPreset", ""));
      case "language": return pget("general.language", "system");
      default: return undefined;
    }
  }
  // Apply one choice through the setting's owner. Returns the step's new value.
  function choose(id, v, part) {
    switch (id) {
      case "from": {
        if (part === "keys") { if (K()?.preset?.() !== v) K().setPreset(v); break; }
        if (part === "wheel") { mouseSet("mouse.wheel", v); break; }
        const f = FROM[v];
        if (!f) throw Error("Unknown choice " + v + ".");
        if (K()?.preset?.() !== f.keys) K().setPreset(f.keys);
        if (pget("mouse.wheel", "zoom") !== f.wheel) mouseSet("mouse.wheel", f.wheel);
        write({from: v});
        break;
      }
      case "theme": {
        const t = T();
        if (part === "accent") { t.set({accent: v || ""}); break; }
        if (v === "system") t.set({followSystem: true});
        else if (t.PRESETS?.[v]) t.setPreset(v);
        else if (G.AtriumThemes?.select) G.AtriumThemes.select(v);
        else if (!t.run?.("theme-" + v)) throw Error("Unknown theme " + v + ".");
        break;
      }
      case "units":
        if (part === "pcbGrid") pset("pcb.grid", +v); else if (part === "schGrid") pset("schematic.grid", +v);
        else { if (!UNITS.includes(v)) throw Error("Units are mm or mil."); pset("general.units", v); }
        break;
      case "mouse": mouseSet(part === "zoomAt" ? "mouse.zoomAt" : part === "invertZoom" ? "mouse.invertZoom" : "mouse.wheel", v); break;
      case "motion": if (!MOTIONS.includes(v)) throw Error("Unknown animation level " + v + "."); T().set({motion: v}); break;
      case "performance": { const x = part === "efficiency" ? efficiency() : renderer(); if (!x) throw Error("This setting is not available."); x.set(v); break; }
      case "fab": if (v) pset("start.fabPreset", v); else P()?.reset?.(["start.fabPreset"]); break;
      case "language": pset("general.language", v); break;
      default: throw Error("Unknown step " + id + ".");
    }
    mark(id, "done");
    return value(id, part);
  }
  const skip = id => mark(id, "skip");
  const close = () => write({seen: true, closed: true});

  // ------------------------------------------------------------------ DOM
  let ui = null;
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  function button(text, fn, cls, variant = "secondary", size) {
    const b = AtriumUI.button(el("button", cls, text), variant, size);
    b.onclick = fn;
    return b;
  }
  const mac = () => { try { return !!K()?.mac || /Mac/i.test(G.navigator?.platform || ""); } catch { return false; } };
  let uid = 0;
  const nextId = p => "wl-" + p + "-" + (++uid);
  const say = (text, error) => { if (!ui) return; ui.status.textContent = text || ""; ui.status.classList.toggle("wl-error", !!error); };
  // Apply a choice and update the current controls and progress.
  function pick(id, v, part, note) {
    try { choose(id, v, part); if (note) say(note); } catch (e) { say(e.message, true); }
    sync();
  }
  // Steps settled by one choice (Coming from, Units, Mouse) open the next step a moment after a click
  // on that choice, so the selection shows first; Theme and Animations stay open to compare options.
  const AUTO = new Set(["from", "units", "mouse"]);
  let pressed = null, pending = 0;
  function later(step) {
    clearTimeout(pending);
    const mounted = ui;
    pending = setTimeout(() => { if (ui === mounted && ui.open === step) advance(step, false); }, 450);
  }
  // Radio cards: native radios, so arrow keys move and choose as in any radio group.
  function radios(step, part, label, options, cls) {
    const g = el("div", "wl-options " + (cls || "")), name = nextId(step);
    g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", label);
    const inputs = [];
    for (const o of options) {
      const l = el("label", "wl-option ui-choice ui-choice-focus"), i = el("input"), text = el("span", "wl-option-text");
      i.type = "radio"; i.name = name; i.value = String(o.value);
      // Activation also fires for a selected radio. Keyboard selection can arrive as
      // a change alone. Apply the choice once across the two native events.
      i.onclick = i.onchange = () => {
        if (!i.checked) return;
        if (String(value(step, part) ?? "") !== i.value) pick(step, o.value, part, o.note);
        else if (!state().done[step]) { mark(step, "done"); sync(); }
        // A click on a one-decision step's main choice moves on to the next step (arrow keys only select).
        const clicked = pressed === i; pressed = null;
        if (clicked && !part && AUTO.has(step)) later(step);
      };
      l.addEventListener("pointerup", () => { pressed = i; });
      if (o.swatch) l.append(o.swatch);
      text.append(el("strong", null, o.title)); if (o.help) text.append(el("span", null, o.help));
      l.append(i, text); g.append(l); inputs.push(i);
    }
    const s = () => { const v = String(value(step, part) ?? ""); for (const i of inputs) i.checked = i.value === v; };
    ui.syncs.push(s); s();
    return g;
  }
  function select(step, part, label, options) {
    const w = el("label", "wl-field"), s = el("select", "ui-field");
    w.append(el("span", null, label), s);
    const fill = () => {
      const v = String(value(step, part) ?? ""), list = typeof options === "function" ? options() : options;
      if (s.dataset.sig !== JSON.stringify(list)) {
        s.replaceChildren(); s.dataset.sig = JSON.stringify(list);
        for (const [val, text, group] of list) {
          let parent = s;
          if (group) { parent = [...s.children].find(c => c.label === group) || s.appendChild(Object.assign(el("optgroup"), {label: group})); }
          const o = el("option", null, text); o.value = String(val); parent.append(o);
        }
      }
      if ([...s.options].some(o => o.value === v)) s.value = v;
    };
    s.onchange = () => pick(step, s.value, part);
    ui.syncs.push(fill); fill();
    return w;
  }
  function check(step, part, label) {
    const l = el("label", "wl-check"), i = el("input");
    i.type = "checkbox"; i.onchange = () => pick(step, i.checked, part);
    l.append(i, el("span", null, label));
    ui.syncs.push(() => { i.checked = !!value(step, part); });
    return l;
  }
  const preview = (label, ...kids) => { const f = el("figure", "wl-preview"); f.setAttribute("aria-label", label); f.append(...kids); return f; };

  // ---- step bodies
  const FROM_TEXT = {
    altium: ["Altium Designer", "Altium keys (P W wire, P T track, T D rule check); the wheel scrolls and Ctrl/⌘+wheel zooms."],
    kicad: ["KiCad", "KiCad-like keys (W wire, X track, M move); the wheel zooms."],
    allegro: ["Allegro / OrCAD", "Allegro-like keys (F2 fit, F3 add connect, F6 done, X typed coordinates); the wheel zooms."],
    eagle: ["Eagle / Fusion Electronics", "Modern keys: one-letter tools and a command palette first; the wheel zooms."],
    new: ["New to PCB design", "Waffle's default keys, which the tutorial and guides use; the wheel zooms."]
  };
  const KEY_PREVIEW = [["route", "pcb", "Route a track"], ["library", "schematic", "Place a component"], ["fit-document", "pcb", "Fit the view"], ["command-palette", "pcb", "Every command"]];
  function bodyFrom(b) {
    b.append(radios("from", "", "Coming from", FROM_ORDER.map(id => ({value: id, title: FROM_TEXT[id][0], help: FROM_TEXT[id][1]})), "wl-list"));
    const fine = el("div", "wl-fields");
    fine.append(select("from", "keys", "Keyboard preset", () => (K()?.presets?.() || []).map(p => [p.id, p.title])),
      select("from", "wheel", "Mouse wheel", [["zoom", "Zooms"], ["altium", "Scrolls; Ctrl/⌘+wheel zooms"]]));
    const keys = el("dl", "wl-keys");
    const fill = () => {
      keys.replaceChildren();
      for (const [id, kind, text] of KEY_PREVIEW) { let k = ""; try { k = K()?.hintFor?.(id, kind) || ""; } catch {} keys.append(el("dt", null, k || "—"), el("dd", null, text)); }
    };
    ui.syncs.push(fill); fill();
    b.append(fine, preview("Keys with this preset", keys));
  }
  // Theme cards show each theme's own colours; library themes get theirs once theme-library.js is in.
  function swatch(id) {
    const s = el("span", "wl-swatch"); s.setAttribute("aria-hidden", "true"); s.dataset.theme = id;
    for (const k of ["app", "panel", "accent", "ink"]) s.append(el("i", "wl-swatch-" + k));
    paint(s); return s;
  }
  function paint(s) {
    const t = T(), id = s.dataset.theme;
    let tok = null;
    try {
      if (id === "system") { const sys = G.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark"; tok = t.PRESETS[sys].tokens; }
      else tok = t.PRESETS?.[id]?.tokens || G.AtriumThemes?.resolved?.(id)?.tokens || t.PRESETS?.[t.LIBRARY?.[id]?.[0] === "light" ? "light" : "dark"]?.tokens;
    } catch {}
    if (!tok) return;
    for (const k of ["app", "panel", "accent", "ink"]) s.querySelector(".wl-swatch-" + k)?.style.setProperty("--swatch", tok[k] === "var(--app)" ? tok.app : tok[k]);
  }
  function themeOptions() {
    const t = T(), out = [{value: "system", title: "System", help: "Light or dark with the OS", swatch: swatch("system")}];
    for (const id of ["dark", "light", ...(t.PRESET_IDS || []).filter(x => x !== "dark" && x !== "light")]) if (t.PRESETS?.[id]) out.push({value: id, title: t.PRESETS[id].label, swatch: swatch(id)});
    for (const [id, [, label]] of Object.entries(t.LIBRARY || {})) out.push({value: id, title: label, swatch: swatch(id)});
    return out;
  }
  function mock() {
    // A small window drawn with the live tokens, so it follows every theme and accent as it applies.
    const m = el("div", "wl-mock"); m.setAttribute("aria-hidden", "true");
    const bar = el("div", "wl-mock-bar"), body = el("div", "wl-mock-body"), side = el("div", "wl-mock-side"), canvas = el("div", "wl-mock-canvas");
    bar.append(el("i"), el("i"), el("i"));
    side.append(el("b", "wl-mock-sel"), el("b"), el("b"));
    canvas.append(el("b", "wl-mock-track"), el("b", "wl-mock-pad"), el("b", "wl-mock-pad wl-mock-pad2"));
    body.append(side, canvas); m.append(bar, body, el("div", "wl-mock-status"));
    return m;
  }
  function bodyTheme(b) {
    b.append(radios("theme", "", "Colour theme", themeOptions(), "wl-grid"));
    const acc = el("div", "wl-accents");
    const accents = [{value: "", title: "Theme", help: "The theme's own"}, ...(T().ACCENTS || []).map(a => ({value: a.hex, title: a.label}))];
    for (const a of accents) { const s = el("span", "wl-dot"); s.setAttribute("aria-hidden", "true"); if (a.value) s.style.setProperty("--swatch", a.value); else s.classList.add("wl-dot-theme"); a.swatch = s; }
    acc.append(el("span", "wl-label", "Accent"), radios("theme", "accent", "Accent colour", accents, "wl-row"));
    b.append(acc, preview("Preview of the theme", mock()));
    // Swatches for the library themes (theme-library.js, loaded only for this step).
    if (!G.AtriumThemes && lazyHas("AtriumThemes")) L().need("AtriumThemes").then(() => { for (const s of b.querySelectorAll(".wl-swatch")) paint(s); }, () => {});
  }
  const fmt = n => String(Math.round(n * 10000) / 10000);
  const gridText = (mm, units) => units === "mil" ? fmt(mm / .0254) + " mil" : fmt(mm) + " mm";
  function bodyUnits(b) {
    b.append(radios("units", "", "Units", [{value: "mm", title: "Millimetres (mm)", help: "Metric parts and most fab houses"}, {value: "mil", title: "Mils (mil)", help: "Thousandths of an inch, as in many US designs"}], "wl-row"));
    const grids = () => {
      const u = value("units"), cur = +value("units", "pcbGrid"), list = PCB_GRIDS[u].map(g => [g, gridText(g, u)]);
      if (!list.some(([g]) => Math.abs(g - cur) < 1e-9)) list.push([cur, gridText(cur, u) + " (current)"]);
      return list.sort((a, c) => a[0] - c[0]);
    };
    const f = el("div", "wl-fields");
    f.append(select("units", "pcbGrid", "Board grid", grids), select("units", "schGrid", "Schematic grid", SCH_GRIDS.map(g => [g, fmt(g / .0254) + " mil (" + fmt(g) + " mm)"])));
    b.append(f, el("p", "wl-note", "For new projects and sheets. Q switches the units of an open project."));
    const svgNS = "http://www.w3.org/2000/svg", s = doc.createElementNS(svgNS, "svg"), cap = el("figcaption");
    s.setAttribute("viewBox", "0 0 160 60"); s.setAttribute("class", "wl-gridpic"); s.setAttribute("aria-hidden", "true");
    const draw = () => {
      s.replaceChildren();
      const g = +value("units", "pcbGrid"), step = Math.max(4, Math.min(20, g * 32));
      for (let x = 4; x < 160; x += step) for (let y = 4; y < 60; y += step) { const c = doc.createElementNS(svgNS, "circle"); c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1)); c.setAttribute("r", ".9"); s.append(c); }
      const p = doc.createElementNS(svgNS, "path"); p.setAttribute("d", "M4 " + (4 + step * 2).toFixed(1) + "h" + (step * 3).toFixed(1) + "l" + (step * 2).toFixed(1) + " -" + (step * 2).toFixed(1) + "h" + (step * 3).toFixed(1)); p.setAttribute("class", "wl-gridpic-track"); s.append(p);
      cap.textContent = "Board grid " + gridText(g, value("units")) + " · a 0.25 mm track reads " + gridText(.25, value("units"));
    };
    ui.syncs.push(draw); draw();
    b.append(preview("Grid preview", s, cap));
  }
  function bodyMouse(b) {
    const mod = mac() ? "⌘" : "Ctrl";
    b.append(radios("mouse", "", "Mouse wheel", [{value: "zoom", title: "Wheel zooms", help: "A notched wheel zooms; Shift+wheel scrolls sideways"}, {value: "altium", title: "Wheel scrolls", help: "As in Altium: " + mod + "+wheel zooms"}], "wl-row"));
    const f = el("div", "wl-fields");
    f.append(select("mouse", "zoomAt", "Zoom towards", [["pointer", "The pointer"], ["centre", "The centre of the view"]]), check("mouse", "invertZoom", "Invert the zoom direction"));
    const dl = el("dl", "wl-keys wl-mouse");
    const fill = () => {
      const scroll = value("mouse") === "altium";
      dl.replaceChildren();
      for (const [k, v] of [["Wheel", scroll ? "Scrolls the view up and down" : "Zooms at the " + (value("mouse", "zoomAt") === "centre" ? "centre" : "pointer")],
        [mod + "+wheel", "Zooms"], ["Shift+wheel", "Scrolls sideways"], ["Right-drag", "Pans (a right-click without moving opens the menu)"],
        ["Middle-drag, Space+drag", "Pans"], ["Side buttons", "Previous and next view"], ["Tilt or thumb wheel", "Pans sideways"],
        ["Trackpad", "Pinch zooms at the fingers; two fingers pan"]]) dl.append(el("dt", null, k), el("dd", null, v));
    };
    ui.syncs.push(fill); fill();
    b.append(f, preview("What the mouse does", dl), el("p", "wl-note", "Preferences › Mouse and Camera has the zoom speed, camera animation and edge scrolling."));
  }
  // What each level animates (motion.js and the CSS motion tokens), listed beside the live preview.
  const MOTION_LIST = {
    full: ["Panels and drawers slide in and out", "Menus and dialogs fade and grow into place", "The view glides on Fit, zoom to selection and Back/Forward",
      "Undo and redo pulse what changed; a new selection gets a short halo"],
    reduce: ["Panels, menus and dialogs fade in place, without sliding", "The view jumps straight to Fit, zoom and Back/Forward", "Undo, redo and selection highlights fade"],
    off: ["Panels, menus and dialogs appear and disappear at once", "The view jumps straight to its new position", "No highlights or fades on the canvas"]
  };
  function bodyMotion(b) {
    const system = G.matchMedia?.("(prefers-reduced-motion: reduce)");
    b.append(radios("motion", "", "Animations", [{value: "system", title: "System", help: "Follow the device’s Reduce Motion setting"},
      {value: "full", title: "Full", help: "Panels slide, dialogs fade and the camera glides"}, {value: "reduce", title: "Reduced", help: "Panels and dialogs fade in place"},
      {value: "off", title: "Off", help: "Every change shows at once"}], "wl-motion-options"));
    const stage = mock(), panel = stage.querySelector(".wl-mock-side"), canvas = stage.querySelector(".wl-mock-canvas"), caption = el("figcaption");
    const list = el("ul", "wl-motion-list");
    stage.classList.add("wl-motion-stage");
    panel.replaceChildren(el("strong", null, "Properties"), el("span", null, "R1 · 10 kΩ"));
    const toggle = button("", () => show(panel.hidden), "wl-small");
    function show(open) {
      panel.hidden = !open;
      toggle.textContent = open ? "Close Properties" : "Open Properties";
      // The board zooms to fit as the panel opens: the camera glides only at Full.
      if (open) { canvas.style.animation = "none"; void canvas.offsetWidth; canvas.style.animation = ""; }
    }
    let lastChoice, lastLevel;
    const update = () => {
      const choice = value("motion");
      let level = choice === "system" ? (system?.matches ? "reduce" : "full") : choice;
      if (level === "full" && doc.documentElement.hasAttribute("data-efficient")) level = "reduce";
      if (choice === lastChoice && level === lastLevel) return;
      lastChoice = choice; lastLevel = level;
      stage.dataset.level = level;
      caption.textContent = {full: "The Properties panel slides in and the board glides to fit.", reduce: "The Properties panel fades in; the board jumps to fit.",
        off: "The Properties panel and the fitted board appear at once."}[level] + (choice === "system" ? " (Your system’s setting.)" : "");
      list.replaceChildren(...MOTION_LIST[level].map(t => el("li", null, t)));
      // Replay opening the panel, including when comparing System with an explicit level.
      panel.hidden = true; void panel.offsetWidth; show(true);
    };
    ui.syncs.push(update);
    system?.addEventListener?.("change", update);
    ui.offs.push(() => system?.removeEventListener?.("change", update));
    if (G.AtriumPower?.onChange) ui.offs.push(G.AtriumPower.onChange(update));
    b.append(preview("Opening the Properties panel", stage, caption, toggle), el("span", "wl-label", "What moves at this level"), list);
  }
  const EFF_TEXT = {auto: "Automatic", always: "Always", on: "Always", off: "Off", never: "Off"};
  // Automatic turns Efficiency mode on only in the system's power-saving mode, never for the battery alone.
  const EFF_AUTO = {mac: "Automatic: in Low Power Mode", windows: "Automatic: with energy saver", linux: "Automatic: in Power Saver mode", "": "Automatic: off in a browser"};
  const EFF_NOTE = {mac: "Efficiency mode gives up a little speed to save energy and keep the computer cooler and quieter. Automatic turns it on while Low Power Mode is on.",
    windows: "Efficiency mode gives up a little speed to save energy and keep the computer cooler and quieter. Automatic turns it on while energy saver or battery saver is on.",
    linux: "Efficiency mode gives up a little speed to save energy and keep the computer cooler and quieter. Automatic turns it on in the Power Saver power mode.",
    "": "Efficiency mode gives up a little speed to save energy and keep the computer cooler and quieter. A browser does not report power saving, so choose Always to use it here."};
  const effTitle = (e, m) => e.titles[m] || (m === "auto" ? EFF_AUTO[e.saver()] : null) || EFF_TEXT[m] || m;
  const REN_TEXT = {auto: ["Automatic", "The GPU where it is hardware-accelerated, else 2D"], gpu: ["GPU (WebGL2)", "Wherever WebGL2 exists"], "2d": ["2D", "The 2D canvas renderer"]};
  function bodyPerformance(b) {
    const r = renderer(), e = efficiency();
    if (r) {
      b.append(el("span", "wl-label", "Renderer"), radios("performance", "", "Renderer", r.modes.map(m => ({value: m, title: REN_TEXT[m]?.[0] || m, help: REN_TEXT[m]?.[1]})), "wl-row"));
      const now = el("p", "wl-note");
      let was = null;
      const show = () => { const d = r.describe(); now.textContent = d ? "In use: " + d : ""; };
      // The renderer switches a moment after the choice; read it again once it has.
      ui.syncs.push(() => { show(); if (was !== null && was !== r.get()) setTimeout(show, 300); was = r.get(); });
      b.append(now);
    }
    if (e) b.append(el("span", "wl-label", "Efficiency mode"), radios("performance", "efficiency", "Efficiency mode", e.modes.map(m => ({value: m, title: effTitle(e, m)})), "wl-row"),
      el("p", "wl-note", EFF_NOTE[e.saver()] || "Efficiency mode gives up a little speed to save energy and keep the computer cooler and quieter."));
  }
  const val = x => (x && typeof x === "object" && "v" in x ? x.v : x);
  function bodyFab(b) {
    const F = () => G.AtriumFabPresets;
    const list = () => [["", "Generic: Waffle's default rules"], ...(F()?.list?.() || []).map(p => [p.id, p.name, p.vendor])];
    b.append(select("fab", "", "Fab preset for new projects", list));
    const card = el("div", "wl-fab");
    const fill = () => {
      card.replaceChildren();
      const id = value("fab"), p = id ? F()?.get?.(id) : null;
      if (!p) { card.append(el("strong", null, "Generic"), el("span", null, "Design rules, layer stack and outputs start from Waffle's defaults. Design › Fab Preset… applies a fab house to a board at any time.")); return; }
      const lim = p.limits || {}, bd = p.build || {};
      card.append(el("strong", null, p.name), el("span", null, p.summary || ""));
      const dl = el("dl", "wl-keys");
      for (const [k, v] of [["Layers", p.layers], ["Track / space", val(lim.track) && val(lim.space) ? val(lim.track) + " / " + val(lim.space) + " mm" : ""], ["Thickness", val(bd.thickness) ? val(bd.thickness) + " mm" : ""], ["Finish", val(bd.finish)]])
        if (v) dl.append(el("dt", null, k), el("dd", null, String(v)));
      card.append(dl);
    };
    ui.syncs.push(fill); fill();
    b.append(preview("Fab preset details", card), el("p", "wl-note", "New projects (File › New, and the blank project on the start page) start with these rules, stack-up and order files. Templates keep their own. Check the fab's current capabilities before ordering."));
    if (!F()?.list?.().length) {
      const need = ["AtriumFabPresets", "AtriumFabPresetsJLCPCB"].filter(n => lazyHas(n));
      if (need.length) L().need(need).then(() => sync(), () => {});
    }
  }
  function mcpPath() {
    let p = "/absolute/path/to/Waffle/mcp/server.py";
    try { if (G.location?.protocol === "file:") p = decodeURIComponent(new URL("../mcp/server.py", G.location.href).pathname); } catch {}
    return G.AtriumHost?.mcpServerPath || p;
  }
  function bodyAI(b) {
    const server = mcpPath(), project = G.AtriumHost?.projectPath || "/absolute/path/to/Design.waffle";
    const q = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'");
    const texts = {cli: "claude mcp add waffle-eda -- " + ["python3", server, "--project", project].map(q).join(" "),
      json: JSON.stringify({mcpServers: {"waffle-eda": {command: "python3", args: [server, "--project", project]}}}, null, 2)};
    b.append(el("p", "wl-text", "Waffle includes an MCP server, so an AI client (Claude, Cursor, VS Code, Codex…) can read a saved project, check it and propose edits that you review here before anything changes."));
    let which = "cli";
    const pre = el("pre", "wl-code"), code = el("code");
    pre.append(code); pre.tabIndex = 0; pre.setAttribute("aria-label", "MCP configuration");
    const g = el("div", "wl-options wl-row"), name = nextId("ai");
    g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", "Configuration format");
    for (const [v, t] of [["cli", "Claude Code command"], ["json", "JSON (Claude Desktop, Cursor…)"]]) {
      const l = el("label", "wl-option ui-choice ui-choice-focus"), i = el("input"); i.type = "radio"; i.name = name; i.value = v; i.checked = v === which;
      i.onchange = () => { which = v; code.textContent = texts[v]; };
      l.append(i, el("span", "wl-option-text", t)); g.append(l);
    }
    code.textContent = texts[which];
    const row = el("div", "wl-actions");
    row.append(button("Copy", () => {
      const done = () => { mark("ai", "done"); say("Copied. Paste it where your AI client keeps its MCP servers."); sync(); };
      try { G.navigator.clipboard.writeText(texts[which]).then(done, () => { selectText(pre); say("Select and copy the text above (" + (mac() ? "⌘" : "Ctrl") + "+C)."); }); } catch { selectText(pre); }
    }, "wl-small"), button("More clients…", () => ui.sp?.run?.("mcp"), "wl-small"));
    b.append(g, pre, row, el("p", "wl-note wl-privacy", "Waffle never writes another app's configuration files: you copy this text and paste it yourself. Waffle sends nothing anywhere by itself; the server runs on this computer and only answers the client you connect."));
  }
  function selectText(n) { try { const r = doc.createRange(); r.selectNodeContents(n); const s = G.getSelection(); s.removeAllRanges(); s.addRange(r); } catch {} }
  function bodyLanguage(b) {
    b.append(select("language", "", "Language", () => [["system", "System default"], ...languages().map(l => [l.id, l.native && l.native !== l.name ? l.native + " – " + l.name : l.name])]),
      el("p", "wl-note", "Menus, the status bar, the start page and Preferences switch at once; restart Waffle to switch everything."));
  }
  const DEFS = {
    from: ["Coming from", "Keys and mouse that feel familiar", bodyFrom, () => FROM_TEXT[value("from")]?.[0] || K()?.presets?.().find(p => p.id === value("from", "keys"))?.title || "Current keyboard and mouse settings"],
    theme: ["Theme", "Colours for the whole window", bodyTheme, () => (value("theme") === "system" ? "System" : T()?.themeName?.(value("theme")) || value("theme"))],
    units: ["Units and grid", "For new projects and sheets", bodyUnits, () => value("units") + " · " + gridText(+value("units", "pcbGrid"), value("units"))],
    mouse: ["Mouse and navigation", "Wheel, buttons and trackpad", bodyMouse, () => (value("mouse") === "altium" ? "Wheel scrolls" : "Wheel zooms")],
    motion: ["Animations", "How much moves on screen", bodyMotion, () => ({system: "System", full: "Full", reduce: "Reduced", off: "Off"})[value("motion")] || ""],
    performance: ["Performance and battery", "Renderer and energy use", bodyPerformance, () => [renderer() && (REN_TEXT[value("performance")]?.[0] || value("performance")), efficiency() && effTitle(efficiency(), value("performance", "efficiency"))].filter(Boolean).join(" · ")],
    fab: ["Fab house", "Rules and outputs for new boards", bodyFab, () => (value("fab") ? G.AtriumFabPresets?.get?.(value("fab"))?.name || value("fab") : "Generic")],
    ai: ["AI assistants (optional)", "Connect an MCP client", bodyAI, () => ""],
    language: ["Language", "The language of the interface", bodyLanguage, () => value("language") === "system" ? "System" : value("language")]
  };

  function sync() {
    if (!ui) return;
    for (const f of ui.syncs) try { f(); } catch {}
    const s = state(), p = progress();
    for (const li of ui.list.children) {
      const id = li.dataset.step, d = DEFS[id];
      li.classList.toggle("wl-done", !!s.done[id]); li.classList.toggle("wl-skipped", !s.done[id] && !!s.skipped[id]);
      const sum = li.querySelector(".wl-summary"); if (sum) sum.textContent = s.done[id] ? d[3]() : s.skipped[id] ? "Skipped" : d[1];
      const st = li.querySelector(".wl-state"); if (st) st.setAttribute("aria-label", s.done[id] ? "Done" : s.skipped[id] ? "Skipped" : "Not done");
      const skipButton = li.querySelector(".wl-skip"); skipButton.hidden = !!s.done[id];
      const next = li.querySelector(".wl-next"); next.hidden = id === "ai" && !s.done.ai;
    }
    ui.count.textContent = p.done + " of " + p.total + " done";
    ui.meter.style.setProperty("--ui-progress", String(p.total ? p.done / p.total : 0));
    ui.meter.setAttribute("aria-valuenow", String(p.done)); ui.meter.setAttribute("aria-valuemax", String(p.total));
    ui.sp?.welcomeProgress?.(p);
  }
  function leaveStep(skipped) {
    const id = ui.open;
    if (!id || state().done[id]) return;
    if (skipped) skip(id);
    else if (id !== "ai") mark(id, "done");
  }
  function expand(id, focus, skipped = false) {
    if (!ui) return;
    if (id !== ui.open) leaveStep(skipped);
    ui.open = id;
    ui.syncs = [];
    for (const li of ui.list.children) {
      const on = li.dataset.step === id, head = li.querySelector(".wl-head"), body = li.querySelector(".wl-body");
      head.setAttribute("aria-expanded", String(on)); li.classList.toggle("wl-open", on);
      body.hidden = !on;
      if (on) {
        ui.syncs = body.syncs ||= [];
        if (!body.dataset.built) { body.dataset.built = "1"; const inner = el("div", "wl-inner"); DEFS[id][2](inner); body.prepend(inner); }
      }
    }
    write({seen: true, open: id || ""});
    sync();
    const head = id && ui.list.querySelector('[data-step="' + id + '"] .wl-head');
    if (head && ui.ready) {
      if (focus) head.focus({preventScroll: true});
      head.scrollIntoView({block: "start", inline: "nearest"});
    }
  }
  function advance(id, skipped) {
    const ids = steps(), i = ids.indexOf(id);
    const next = ids[i + 1];
    expand(next || "", true, skipped);
    if (!next) ui.finish.querySelector("button").focus();
  }
  function stepCard(id) {
    const [title, help] = DEFS[id], li = el("li", "wl-step"), hb = button(null, null, "wl-head", "quiet"), body = el("div", "wl-body"), bid = nextId("body");
    li.dataset.step = id; hb.setAttribute("aria-controls", bid); hb.setAttribute("aria-expanded", "false"); body.id = bid; body.hidden = true;
    body.setAttribute("role", "region"); body.setAttribute("aria-label", title);
    const mk = el("span", "wl-state"), txt = el("span", "wl-head-text");
    txt.append(el("strong", null, title), el("span", "wl-summary", help));
    hb.append(mk, txt);
    hb.onclick = () => expand(hb.getAttribute("aria-expanded") === "true" ? "" : id);
    const foot = el("div", "wl-step-foot");
    foot.append(button("Skip", () => advance(id, true), "wl-skip", "quiet", "sm"),
      button("Next", () => advance(id, false), "wl-next", "primary", "sm"));
    body.append(foot); li.append(hb, body); return li;
  }
  function build(container) {
    const panel = el("section", "wl-panel"); panel.setAttribute("aria-labelledby", "wl-title");
    const head = el("header", "wl-top"), titles = el("div", "wl-titles"), h = el("h3", "wl-title", "Get set up");
    h.id = "wl-title";
    titles.append(h, el("p", "wl-lead", "Choices apply immediately. Open another step or choose Next to keep the settings shown."));
    const tools = el("div", "wl-tools");
    tools.append(button("Import settings…", () => ui.sp?.importSettings?.(), "wl-small", "secondary", "sm"));
    head.append(titles, tools);
    // The library progress bar (docs/ui-library.md › Progress): --ui-progress carries the fraction done.
    const meter = el("div", "ui-progress wl-meter"), count = el("span", "wl-count");
    meter.setAttribute("role", "progressbar"); meter.setAttribute("aria-label", "Set-up progress"); meter.setAttribute("aria-valuemin", "0");
    const prog = el("div", "wl-progress"); prog.append(meter, count);
    const list = el("ol", "wl-steps");
    for (const id of steps()) list.append(stepCard(id));
    // Up/Down, Home/End move between the step headings (an accordion).
    list.addEventListener("keydown", e => {
      const heads = [...list.querySelectorAll(".wl-head")], i = heads.indexOf(doc.activeElement);
      if (i < 0) return;
      const j = {ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: heads.length - 1}[e.key];
      if (j != null) { e.preventDefault(); heads[(j + heads.length) % heads.length].focus(); }
    });
    const finish = el("div", "wl-finish");
    finish.append(button("Finish setup", () => { leaveStep(false); close(); ui.sp?.closeWelcome?.(); }, "wl-primary", "primary"));
    const st = el("p", "wl-status"); st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite");
    panel.append(head, prog, list, finish, st);
    container.replaceChildren(panel);
    return {panel, list, count, meter, finish, status: st};
  }
  // Settings changed elsewhere (Preferences, the theme picker, an import) show here at once.
  function listen() {
    const offs = [];
    try { offs.push(P()?.on?.(() => sync())); } catch {}
    try { offs.push(T()?.onChange?.(() => sync())); } catch {}
    try { offs.push(K()?.onChange?.(() => sync())); } catch {}
    return offs.filter(f => typeof f === "function");
  }
  function mount(container, sp) {
    if (!doc || !container) return null;
    if (setupDialog?.open && !setupDialog.contains(container)) setupDialog.close();
    unmount();
    const s = write({seen: true, closed: false});
    ui = {syncs: [], sp, open: "", ...build(container)};
    ui.offs = listen();
    // Insert a late performance card without replacing the user's controls, scroll or focus.
    const late = ["AtriumCanvasGPUPref", "AtriumPower"].filter(n => !G[n] && lazyHas(n));
    const mounted = ui;
    if (late.length) Promise.allSettled(late.map(n => L().need(n))).then(() => {
      if (ui !== mounted) return;
      steps().forEach((id, i) => {
        if (ui.list.children[i]?.dataset.step !== id) ui.list.insertBefore(stepCard(id), ui.list.children[i] || null);
      });
      sync();
    });
    const ids = steps(), open = ids.includes(s.open) ? s.open : ids.find(id => !s.done[id] && !s.skipped[id]) || "";
    expand(open, false); ui.ready = true;
    try { G.performance?.mark?.("atrium-welcome-ready"); } catch {}
    return ui.panel;
  }
  function unmount(container) {
    if (!ui || (container && !container.contains(ui.panel))) return;
    for (const off of ui.offs || []) try { off(); } catch {}
    ui.panel.remove(); ui = null;
  }
  const focus = () => { const h = ui?.list.querySelector('.wl-head[aria-expanded="true"]') || ui?.list.querySelector(".wl-head"); h?.focus(); return !!h; };

  // Help opens the same walkthrough directly from the editor.
  let setupDialog;
  function reopen() {
    if (setupDialog?.open) { focus(); return setupDialog; }
    G.AtriumStartPage?.close();
    const container = el("div"), host = G.AtriumNavHost;
    const dialog = G.AtriumShell.dialog({title:"Customise Waffle", body:[container], actions:[],
      onClose:() => unmount(container)});
    setupDialog = dialog;
    mount(container, {
      run:action => { dialog.close(); host?.act(action); },
      importSettings:() => host?.act("import-settings"),
      closeWelcome:() => dialog.close()
    });
    focus();
    return dialog;
  }
  try { G.AtriumNavCommon?.ready?.(h => h.registerAction?.("customise-waffle", reopen)); } catch {}
  return Object.freeze({STORE, FROM, firstLaunch, state, steps, progress, value, choose, skip, close, reset, mount, unmount, focus, renderer, efficiency,
    isMounted: container => !!ui?.panel.isConnected && (!container || container.contains(ui.panel))});
})();
