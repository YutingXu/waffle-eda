"use strict";
// AtriumThemes: colour themes as single JSON documents (format "atrium-theme" v1), the built-in
// themes, and the registry the theme picker, gallery and editor read (docs/themes.md).
// Loaded lazily (lazy.js); AtriumTheme (theme.js, eager) only keeps the resolved colours of the
// themes in use, cached so the saved theme paints before the first frame.
//
//   AtriumThemes.validate(doc)       -> {ok, errors, warnings, doc}   (sanitised copy: known keys, hex colours)
//   AtriumThemes.resolve(doc)        -> {tokens, canvas:{pcb:{system, layers}, sch}, syntax, report}
//   AtriumThemes.list({family})      -> [{id, name, type, family, source}]
//   AtriumThemes.get(id) / document(id) / exportJSON(id) / select(id)
//   AtriumThemes.saveUser(doc, id?) / removeUser(id)            the theme editor's themes
//   AtriumThemes.registerExtension(extId, themes) / unregisterExtension(extId)
//   AtriumThemes.importText(text)    -> Promise<{id, doc, report}>  Waffle or VS Code theme JSON
//   AtriumThemes.layerReport(layers) -> {minDeltaE, minDeltaEDeuteranopia, pairs}
//
// A theme file is untrusted input. Only the keys below are read; every colour must be a hex
// literal (#rgb, #rrggbb, or #rrggbbaa where translucency makes sense) and is applied with
// style.setProperty("--token", value) after validation. No CSS text, selector, url() or name
// from a file ever reaches a stylesheet.
globalThis.AtriumThemes = (() => {
  const T = globalThis.AtriumTheme, C = T.color;
  const FORMAT = 1, MAX_TEXT = 512 * 1024, MAX_USER = 50;
  const TYPES = Object.freeze(["dark", "light", "hc-dark", "hc-light"]);
  // The CSS preset block a theme sits on (data-theme): its colour-scheme and the scoped tokens.
  const BASE_OF = Object.freeze({dark: "dark", light: "light", "hc-dark": "hc", "hc-light": "light"});
  const PALETTE = Object.freeze(["background", "surface", "foreground", "accent", "primary", "selection", "focus", "border",
    "error", "warning", "success", "info"]);
  const SYNTAX = Object.freeze(["keyword", "string", "number", "comment", "function", "type", "variable", "operator", "constant", "punctuation"]);
  const SYSTEM = Object.freeze(["workspace", "workspaceGrid", "workspaceGridCoarse", "board", "boardGrid", "boardGridCoarse", "edge", "hole", "padHole",
    "drillEdge", "dim", "selection", "connection", "origin", "padText"]);
  const NAMED_LAYERS = Object.freeze(["Top", "Bottom", "Silk", "Bottom silk", "Multi", "Top mask", "Bottom mask", "Top paste", "Bottom paste",
    "Keepout", "Mechanical", "Drill guide", "Drill drawing"]);
  const SCH = Object.freeze(["workspace", "paper", "grid"]);
  const TOP = new Set(["atrium-theme", "id", "name", "type", "extends", "author", "description", "palette", "colors", "canvas", "syntax", "iconTint"]);
  const TOKEN_SET = new Set([...T.TOKENS, ...T.OPTIONAL]);
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const ID = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;
  // Copper layers checked for distinguishable colours (an eight-layer board).
  const COPPER = Object.freeze(["Top", "Bottom", "Inner 1", "Inner 2", "Inner 3", "Inner 4", "Inner 5", "Inner 6"]);
  const ALTIUM_SYSTEM = Object.freeze({workspace: "#3b3b3b", workspaceGrid: "#444444", workspaceGridCoarse: "#4d4d4d", board: "#000000", boardGrid: "#1e1e1e",
    boardGridCoarse: "#363636", edge: "#a3a3a3", hole: "#2c2e33", padHole: "#1d6d8c", drillEdge: "#9c9c9c", dim: "#545454", selection: "#ffffff",
    connection: "#b4b4b4", origin: "#e8e8e8", padText: "#fffffe"});
  const ALTIUM_LAYERS = Object.freeze({Top: "#ff0000", Bottom: "#0000ff", "Inner 1": "#bc8e00", "Inner 2": "#70dbfa", "Inner 3": "#00cc66",
    "Inner 4": "#9b9bff", "Inner 5": "#00ffff", "Inner 6": "#800081", Silk: "#ffff00", "Bottom silk": "#808000", Multi: "#c0c0c0"});
  const layerName = k => NAMED_LAYERS.includes(k) || /^Inner ([1-9]\d?|1[01]\d|12[0-6])$/.test(k) || /^Mechanical ([1-9]|[12]\d|3[0-2])$/.test(k);

  // ------------------------------------------------------------------ colour
  const hex = v => typeof v === "string" && HEX.test(v.trim()) ? v.trim().toLowerCase() : null;
  const solid = v => { const h = hex(v); return h && (h.length === 4 || h.length === 7) ? C.hex(h) : null; };
  const mix = C.mix, contrast = C.contrast, W = "#ffffff", B = "#000000";
  const isDark = c => C.luminance(c) < .18;
  function legible(fg, bg, min) {
    let out = C.ensureContrast(fg, bg, min);
    if (contrast(out, bg) < min) out = C.bestInk(bg);
    return out;
  }
  // CIE L*a*b* (D65) and the CIE76 colour difference.
  const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const gam = v => 255 * (v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055);
  function lab(color) {
    const [r, g, b] = C.rgba(color).slice(0, 3).map(lin);
    const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
    const x = f((.4124 * r + .3576 * g + .1805 * b) / .95047), y = f(.2126 * r + .7152 * g + .0722 * b), z = f((.0193 * r + .1192 * g + .9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  // Deuteranopia (Machado, Oliveira and Fernandes 2009, severity 1), applied in linear RGB.
  function deuteranopia(color) {
    const [r, g, b] = C.rgba(color).slice(0, 3).map(lin);
    const m = [[.367322, .860646, -.227968], [.280085, .672501, .047413], [-.01182, .04294, .968881]];
    const out = m.map(row => Math.max(0, Math.min(1, row[0] * r + row[1] * g + row[2] * b)));
    return "#" + out.map(v => Math.round(gam(v)).toString(16).padStart(2, "0")).join("");
  }
  // The smallest colour difference between visible copper layers, normal vision and simulated
  // deuteranopia (the commonest colour-vision deficiency).
  function layerReport(layers, board) {
    const get = k => solid(layers?.[k]) || ALTIUM_LAYERS[k];
    const pairs = [];
    for (let i = 0; i < COPPER.length; i++) for (let j = i + 1; j < COPPER.length; j++) {
      const a = get(COPPER[i]), b = get(COPPER[j]);
      pairs.push({a: COPPER[i], b: COPPER[j], deltaE: +deltaE(a, b).toFixed(1), deuteranopia: +deltaE(deuteranopia(a), deuteranopia(b)).toFixed(1)});
    }
    const min = k => pairs.reduce((m, p) => p[k] < m[k] ? p : m, pairs[0]);
    const out = {minDeltaE: min("deltaE").deltaE, closest: min("deltaE"), minDeltaEDeuteranopia: min("deuteranopia").deuteranopia,
      closestDeuteranopia: min("deuteranopia"), pairs};
    if (board) out.minOnBoard = +Math.min(...COPPER.map(k => contrast(get(k), board))).toFixed(2);
    return out;
  }

  // ------------------------------------------------------------------ validation
  // Every problem is listed; `doc` keeps what was valid. Imports require ok.
  function validate(input) {
    const errors = [], warnings = [], doc = {"atrium-theme": FORMAT};
    const bad = m => errors.push(m);
    if (!input || typeof input !== "object" || Array.isArray(input)) return {ok: false, errors: ["A theme must be a JSON object."], warnings, doc};
    for (const k of Object.keys(input)) if (!TOP.has(k)) bad("Unknown key \"" + String(k).slice(0, 40) + "\".");
    if (input["atrium-theme"] !== FORMAT) bad("\"atrium-theme\" must be " + FORMAT + ".");
    const text = (k, max, required) => {
      if (!(k in input)) { if (required) bad("\"" + k + "\" is required."); return; }
      const v = input[k];
      if (typeof v !== "string" || !v.trim() || v.length > max) bad("\"" + k + "\" must be a string of at most " + max + " characters.");
      else doc[k] = v.trim().replace(/[\u0000-\u001f\u007f]/g, "");
    };
    text("name", 80, true); text("author", 80); text("description", 400);
    if ("id" in input) { if (typeof input.id === "string" && ID.test(input.id)) doc.id = input.id; else bad("\"id\" must be letters, digits, '.', '_' or '-'."); }
    if ("extends" in input) { if (typeof input.extends === "string" && /^[\w.:/-]{1,120}$/.test(input.extends)) doc.extends = input.extends; else bad("\"extends\" must be a theme id."); }
    if (TYPES.includes(input.type)) doc.type = input.type; else bad("\"type\" must be one of " + TYPES.join(", ") + ".");
    const colorMap = (obj, path, ok, opts = {}) => {
      if (obj == null) return null;
      if (typeof obj !== "object" || Array.isArray(obj)) { bad("\"" + path + "\" must be an object."); return null; }
      const out = {}, keys = Object.keys(obj);
      if (keys.length > 300) { bad("\"" + path + "\" has too many entries."); return null; }
      for (const k of keys) {
        const name = opts.dashes ? k.replace(/^--/, "") : k;
        if (!ok(name)) { bad("Unknown " + path + " key \"" + String(k).slice(0, 40) + "\"."); continue; }
        const v = opts.alpha ? hex(obj[k]) : solid(obj[k]);
        if (!v) { bad("\"" + path + "." + name + "\" must be a hex colour" + (opts.alpha ? "" : " without transparency") + "."); continue; }
        out[name] = v;
      }
      return out;
    };
    const p = colorMap(input.palette, "palette", k => PALETTE.includes(k)); if (p) doc.palette = p;
    const c = colorMap(input.colors, "colors", k => TOKEN_SET.has(k), {dashes: true, alpha: true}); if (c) doc.colors = c;
    const s = colorMap(input.syntax, "syntax", k => SYNTAX.includes(k)); if (s) doc.syntax = s;
    if ("iconTint" in input) { const v = solid(input.iconTint); if (v) doc.iconTint = v; else bad("\"iconTint\" must be a hex colour."); }
    if ("canvas" in input) {
      const cv = input.canvas;
      if (!cv || typeof cv !== "object" || Array.isArray(cv)) bad("\"canvas\" must be an object.");
      else {
        for (const k of Object.keys(cv)) if (k !== "pcb" && k !== "sch") bad("Unknown canvas key \"" + String(k).slice(0, 40) + "\".");
        const out = {};
        if (cv.pcb != null) {
          if (typeof cv.pcb !== "object" || Array.isArray(cv.pcb)) bad("\"canvas.pcb\" must be an object.");
          else {
            for (const k of Object.keys(cv.pcb)) if (k !== "system" && k !== "layers") bad("Unknown canvas.pcb key \"" + String(k).slice(0, 40) + "\".");
            const sys = colorMap(cv.pcb.system, "canvas.pcb.system", k => SYSTEM.includes(k));
            const lay = colorMap(cv.pcb.layers, "canvas.pcb.layers", layerName);
            out.pcb = {}; if (sys) out.pcb.system = sys; if (lay) out.pcb.layers = lay;
          }
        }
        const sch = colorMap(cv.sch, "canvas.sch", k => SCH.includes(k));
        if (sch) {
          // Schematic inks (navy wires, maroon parts, green selection) are the design's own: the sheet stays light.
          if (sch.paper && C.luminance(sch.paper) < .6) { bad("\"canvas.sch.paper\" must be a light colour so schematic ink stays legible."); delete sch.paper; }
          out.sch = sch;
        }
        doc.canvas = out;
      }
    }
    const surf = doc.palette?.surface || doc.palette?.background;
    if (surf && doc.type && isDark(surf) !== (doc.type === "dark" || doc.type === "hc-dark")) warnings.push("The base surface " + surf + " is " + (isDark(surf) ? "dark" : "light") + " but the type is " + doc.type + "; text may not reach 4.5:1.");
    if (doc.type && !doc.extends && !doc.palette && !doc.colors) warnings.push("The theme sets no colours; it uses the " + doc.type + " defaults.");
    return {ok: !errors.length, errors, warnings, doc};
  }

  // ------------------------------------------------------------------ derivation
  // Every UI token from a few base colours (palette) and the theme type.
  function derive(type, p = {}) {
    const dark = type === "dark" || type === "hc-dark", hc = type === "hc-dark" || type === "hc-light";
    const panel = p.surface || p.background || (dark ? (hc ? "#000000" : "#303030") : (hc ? "#ffffff" : "#f8f8f8"));
    const app = p.background || (dark ? mix(panel, B, hc ? 0 : .38) : mix(panel, B, hc ? 0 : .07));
    const ink = p.foreground || (dark ? (hc ? W : "#e2e2e2") : (hc ? B : "#1f1f1f"));
    const defaults = T.PRESETS[dark ? hc ? "hc" : "dark" : "light"].tokens;
    const accent = p.accent || defaults.accent;
    const border = p.border || (hc ? (dark ? "#6fc3df" : "#0f4a85") : null);
    const toward = (c, x) => mix(c, ink, x), t = {};
    t.panel = panel; t.app = app;
    t.chrome = hc ? panel : mix(panel, app, .5);
    t["panel-head"] = toward(panel, .07); t.raised = toward(panel, .14); t.hover = toward(panel, .07); t.pressed = toward(panel, .18);
    t.field = dark ? mix(panel, B, hc ? 0 : .3) : hc ? W : mix(panel, W, .85);
    t["menu-bg"] = dark ? mix(panel, B, hc ? 0 : .06) : mix(panel, W, .8);
    t["tab-bg"] = mix(app, t.chrome, .5); t["tab-hover"] = toward(t["tab-bg"], .07);
    t["canvas-bg"] = dark ? mix(app, B, .5) : "#1e1e1e";
    t["bar-bg"] = t["menu-bg"] + "f2";
    t.ink = ink; t.muted = mix(ink, panel, .28); t.faint = mix(ink, panel, .4);
    t.line = border || toward(panel, .14); t["line-strong"] = border || toward(panel, .26); t.soft = toward(panel, .04);
    t.divider = border || app; t.rule = dark ? mix(panel, B, .2) : toward(panel, .12);
    t["bar-line"] = t["line-strong"];
    t.accent = accent;
    t.focus = p.focus || defaults.focus;
    t.primary = p.primary || defaults.primary;
    t["on-primary"] = C.bestInk(t.primary, "#141414", W); t["primary-line"] = mix(t.primary, dark ? W : B, .15);
    t.selection = p.selection || mix(panel, t.primary, dark ? .5 : .22);
    t["selection-ink"] = C.bestInk(t.selection, dark ? "#141414" : ink, W); t["sel-sub-ink"] = mix(t["selection-ink"], t.selection, .12);
    t["layer-on"] = dark ? toward(t.chrome, .14) : W; t["ls-bg"] = mix(t.chrome, B, dark ? .12 : .05);
    t.button = toward(panel, .08); t["button-line"] = border || toward(panel, .24); t["button-hover"] = toward(panel, .15); t["input-line"] = border || toward(panel, .22);
    t.sheet = "#fffcf8";
    t["ink-bright"] = mix(ink, dark ? W : B, .6); t["ink-strong"] = mix(ink, dark ? W : B, .35);
    t["head-ink"] = ink; t["tab-hover-ink"] = ink; t["coords-ink"] = ink;
    t["chrome-ink"] = mix(ink, t.chrome, .06); t["tool-ink"] = mix(ink, t.chrome, .08); t["soft-ink"] = mix(ink, panel, .08);
    t["icon-ink"] = mix(ink, panel, .14); t["dim-ink"] = mix(ink, t.chrome, .16); t["caption-ink"] = mix(ink, panel, .18);
    t["tab-ink"] = mix(ink, t["tab-bg"], .2); t["split-ink"] = mix(ink, panel, .26);
    t["on-accent"] = t["on-accent-2"] = t["accent-btn-ink"] = C.bestInk(accent, "#141414", W);
    const error = p.error || (dark ? "#f0706a" : "#c4281c"), warning = p.warning || (dark ? "#f0c46a" : "#8a5a00");
    const success = p.success || (dark ? "#7fd18f" : "#17772f"), info = p.info || (dark ? "#75beff" : "#0b62b0");
    for (const icon of ["icon-folder", "icon-sch", "icon-pcb"]) t[icon] = defaults[icon];
    t["error-ink"] = error; t["diff-changed"] = info; t["diff-added"] = success; t["diff-removed"] = mix(error, warning, .35);
    t["ok-ink"] = success; t["ok-line"] = mix(success, panel, .55); t["warn-line"] = mix(warning, panel, .55);
    t["bad-ink"] = t["diff-removed"]; t["bad-line"] = mix(t["bad-ink"], panel, .55);
    t["ls-ink"] = error; t["err-mark"] = error; t["warn-mark"] = warning; t["ok-mark"] = success; t["warn-ink"] = warning; t["km-warn"] = warning;
    t["badge-line"] = dark ? "#ffffff66" : "#0b0b0b66"; t["conflict-line"] = mix(warning, panel, .3);
    t.danger = error; t.warning = warning; t.info = info; t["danger-fill"] = dark ? "#c4281c" : "#c4281c"; t["on-danger"] = W;
    const sh = dark ? {sm: "#00000077", md: "#00000099", lg: "#000000bb", backdrop: "#00000088", drawer: "#000000aa", swatch: "#00000066", preview: "#00000055", side: "#00000044", vc: "#00000080", line: "#ffffff47"}
      : {sm: "#00000024", md: "#00000030", lg: "#00000040", backdrop: "#00000040", drawer: "#00000030", swatch: "#00000059", preview: "#00000033", side: "#00000022", vc: "#0000002e", line: "#0000004d"};
    Object.assign(t, {"shadow-sm": sh.sm, "shadow-md": sh.md, "shadow-lg": sh.lg, backdrop: sh.backdrop, "shadow-drawer": sh.drawer, "swatch-edge": sh.swatch,
      "preview-edge": sh.preview, "shadow-side": sh.side, "shadow-vc": sh.vc, "swatch-line": sh.line});
    if (hc) Object.assign(t, {"swatch-edge": dark ? "#ffffff80" : "#00000080", "preview-edge": dark ? "#ffffff80" : "#00000080"});
    return t;
  }
  // Text pairs every resolved theme meets: [ink token, surface token, minimum ratio]. The first
  // block is tests/css-tokens.py's guard (WCAG AA for text); the rest are the VS Code import's.
  const TEXT = Object.freeze([
    ["ink", "panel", 4.5], ["ink", "chrome", 4.5], ["ink", "field", 4.5], ["ink", "menu-bg", 4.5], ["ink", "app", 4.5],
    ["muted", "panel", 4.5], ["muted", "chrome", 4.5], ["muted", "field", 4.5], ["muted", "menu-bg", 4.5], ["muted", "hover", 4.5], ["muted", "panel-head", 4.5],
    ["faint", "panel", 4.5], ["faint", "chrome", 4.5], ["faint", "field", 4.5],
    ...["ok-ink", "warn-ink", "error-ink", "danger", "warning", "info"].flatMap(k => ["panel", "chrome", "field", "menu-bg"].map(b => [k, b, 4.5])),
    ["selection-ink", "selection", 4.5], ["ink", "selection", 4.5], ["on-primary", "primary", 4.5], ["on-danger", "danger-fill", 4.5],
    ["ink", "hover", 4.5], ["ink", "button", 4.5], ["ink", "raised", 4.5], ["sel-sub-ink", "selection", 4.5],
    ["on-accent", "accent", 4.5], ["accent-btn-ink", "accent", 4.5], ["on-accent-2", "accent", 4.5], ["accent-text", "panel", 4.5],
    ["chrome-ink", "chrome", 4.5], ["coords-ink", "chrome", 4.5], ["dim-ink", "chrome", 4.5], ["tool-ink", "chrome", 4.5],
    ["tab-ink", "tab-bg", 4.5], ["tab-hover-ink", "tab-hover", 4.5], ["ink-bright", "panel-head", 4.5], ["ink-bright", "layer-on", 4.5], ["head-ink", "panel-head", 4.5],
    ["icon-ink", "panel", 4.5], ["caption-ink", "panel", 4.5], ["split-ink", "panel", 4.5], ["soft-ink", "panel", 4.5], ["ink-strong", "panel", 4.5],
    ["bad-ink", "panel", 4.5], ["km-warn", "panel", 4.5], ["diff-changed", "panel", 4.5], ["diff-added", "panel", 4.5], ["diff-removed", "panel", 4.5], ["ls-ink", "ls-bg", 4.5],
    // At rest and during hover, shortcuts, hints and status labels stay readable.
    ...["raised", "button-hover", "tab-hover"].map(b => ["muted", b, 4.5]),
    ...["menu-bg", "hover", "panel-head", "tab-bg"].map(b => ["faint", b, 4.5]),
    ...["chrome", "menu-bg", "panel-head", "hover"].map(b => ["accent-text", b, 4.5]),
    ...["ok-ink", "warn-ink"].map(k => [k, "panel-head", 4.5]),
    ["ink", "button-hover", 4.5]
  ]);
  const UI = Object.freeze([
    // Focus rings are drawn inside these fills. Selected and primary controls use
    // their own foreground colour for the ring, also checked in TEXT.
    ...["app", "chrome", "panel", "panel-head", "raised", "hover", "field", "menu-bg", "tab-bg",
      "tab-hover", "button", "button-hover", "pressed", "layer-on", "ls-bg", "bar-bg"].map(b => ["focus", b, 3]),
    ...["accent", "err-mark", "warn-mark", "ok-mark", "icon-folder", "icon-sch", "icon-pcb"].map(k => [k, "panel", 3]),
    // The border identifies the control against both its fill and the surrounding surface.
    ...["button", "button-hover", "panel", "panel-head", "chrome", "raised", "menu-bg"].map(b => ["button-line", b, 3]),
    ...["field", "panel", "panel-head", "chrome", "raised", "menu-bg"].map(b => ["input-line", b, 3]),
    ...["panel", "panel-head", "chrome", "menu-bg", "raised"].map(b => ["primary-line", b, 3])
  ]);
  const CONTRAST = Object.freeze([...TEXT, ...UI]);
  const SURFACES = Object.freeze(["app", "chrome", "panel", "panel-head", "raised", "hover", "pressed", "field", "menu-bg", "tab-bg", "tab-hover", "button", "button-hover", "layer-on", "ls-bg"]);
  const opaque = (v, under) => { const a = C.rgba(v); return a && a[3] < 1 ? C.over(v, under) : C.hex(v); };

  // ------------------------------------------------------------------ registry
  const registry = new Map();   // id -> {id, doc, source, ext?}
  const resolved = new Map();   // id -> resolve() result
  function legacyDoc(id) {
    const P = T.PRESETS[id], t = {...P.tokens};
    if (t.divider === "var(--app)") t.divider = t.app;
    if (/^rgba/.test(t["bar-bg"])) t["bar-bg"] = C.hex(t["bar-bg"]) + "f0";
    if (/^rgba/.test(t["shadow-vc"])) t["shadow-vc"] = "#00000080";
    if (/^rgba/.test(t["swatch-line"])) t["swatch-line"] = "#ffffff47";
    const colors = {}; for (const k of T.TOKENS) if (hex(t[k])) colors[k] = t[k].toLowerCase();
    const canvas = {pcb: {system: {...P.canvas.pcb}}, sch: {...P.canvas.sch}};
    return {"atrium-theme": FORMAT, id, name: P.label, type: id === "hc" ? "hc-dark" : P.family === "dark" ? "dark" : "light", colors, canvas};
  }
  // Resolve a validated document: parent (extends) or derived tokens, the theme's own colours, then
  // every text pair checked; colours the theme did not set are nudged until they pass, colours it did
  // set are reported (the editor shows them; built-in themes have none).
  function resolve(doc, seen = new Set()) {
    const type = doc.type || "dark", report = {adjusted: [], warnings: [], contrast: []};
    let tokens, canvas = {pcb: {system: {...ALTIUM_SYSTEM}, layers: {}}, sch: {workspace: "#a3a3a3", paper: "#fffcf8", grid: "#e6e3dc"}}, syntax = {};
    const parent = doc.extends && !seen.has(doc.extends) ? docOf(doc.extends) : null;
    if (parent) {
      const r = resolve(parent, new Set([...seen, doc.extends]));
      tokens = {...r.tokens}; canvas = {pcb: {system: {...r.canvas.pcb.system}, layers: {...r.canvas.pcb.layers}}, sch: {...r.canvas.sch}}; syntax = {...r.syntax};
      if (doc.palette) Object.assign(tokens, pick(derive(type, {...paletteOf(tokens), ...doc.palette}), Object.keys(doc.palette)));
    } else tokens = derive(type, doc.palette || {});
    if (doc.extends && !parent) report.warnings.push("The base theme \"" + doc.extends + "\" is not installed; the " + type + " defaults were used.");
    const explicit = new Set(Object.keys(doc.colors || {}));
    Object.assign(tokens, doc.colors || {});
    if (doc.iconTint) { tokens["icon-ink"] = doc.iconTint; explicit.add("icon-ink"); }
    // Tokens a theme leaves to its accent follow it.
    if (doc.colors?.accent && !explicit.has("on-accent")) tokens["on-accent"] = tokens["on-accent-2"] = tokens["accent-btn-ink"] = C.bestInk(tokens.accent, "#141414", W);
    // Surfaces the theme did not set move away from its ink until text of the theme's kind can sit on
    // them (a mid-grey base colour would otherwise leave no legible ink at all).
    const away = type === "dark" || type === "hc-dark" ? B : W, inkEnd = away === B ? W : B;
    for (const bg of SURFACES) {
      if (explicit.has(bg) || !tokens[bg] || parent || (doc.palette && ((bg === "panel" && doc.palette.surface) || (bg === "app" && doc.palette.background)))) continue;
      let c = opaque(tokens[bg], tokens.panel);
      for (let i = 0; i < 30 && contrast(inkEnd, c) < 4.8; i++) c = mix(c, away, .06);
      if (c !== opaque(tokens[bg], tokens.panel)) { report.adjusted.push({token: bg, from: tokens[bg], to: c}); tokens[bg] = c; }
    }
    for (let pass = 0; pass < 2; pass++) for (const [fg, bg, min] of CONTRAST) {
      if (fg === "accent-text") continue;
      const f = tokens[fg], b = tokens[bg];
      if (!f || !b) continue;
      const back = opaque(b, tokens.panel), ink = opaque(f, back), r = contrast(ink, back);
      if (r >= min - 1e-9) continue;
      if (explicit.has(fg)) { if (pass === 0) report.warnings.push("--" + fg + " on --" + bg + " is " + r.toFixed(2) + ":1 (needs " + min + ":1)."); continue; }
      tokens[fg] = legible(ink, back, min); report.adjusted.push({token: fg, on: bg, from: f, to: tokens[fg]});
    }
    Object.assign(tokens, T.accentRoles(tokens));
    for (const [fg, bg, min] of CONTRAST) if (tokens[fg] && tokens[bg]) {
      const back = opaque(tokens[bg], tokens.panel);
      const ratio = contrast(opaque(tokens[fg], back), back);
      if (fg === "accent-text" && ratio < min) report.warnings.push("--" + fg + " on --" + bg + " is " + ratio.toFixed(2) + ":1 (needs " + min + ":1).");
      report.contrast.push({token: fg, on: bg, ratio: +ratio.toFixed(2), min});
    }
    const cv = doc.canvas || {};
    Object.assign(canvas.pcb.system, cv.pcb?.system || {}); Object.assign(canvas.pcb.layers, cv.pcb?.layers || {});
    Object.assign(canvas.sch, cv.sch || {});
    if (cv.sch?.paper && !cv.sch.grid) canvas.sch.grid = mix(cv.sch.paper, B, .1);
    if (cv.pcb?.system?.workspace && !cv.pcb.system.workspaceGrid) {
      const ws = cv.pcb.system.workspace, to = isDark(ws) ? W : B;
      canvas.pcb.system.workspaceGrid = mix(ws, to, .045); canvas.pcb.system.workspaceGridCoarse = mix(ws, to, .09);
    }
    tokens.sheet = explicit.has("sheet") ? tokens.sheet : canvas.sch.paper;
    Object.assign(syntax, doc.syntax || {});
    for (const k of SYNTAX) if (!syntax[k]) syntax[k] = defaultSyntax(type)[k];
    for (const k of SYNTAX) syntax[k] = legible(syntax[k], opaque(tokens.field, tokens.panel), 4.5);
    report.layers = layerReport(canvas.pcb.layers, canvas.pcb.system.board);
    const family = type === "dark" || type === "hc-dark" ? "dark" : "light";
    return {name: doc.name, type, family, base: BASE_OF[type], scheme: family, tokens, canvas, syntax, report};
  }
  const pick = (o, keys) => { const m = {}; for (const k of keys) if (k in o) m[k] = o[k]; return m; };
  const paletteOf = t => ({background: t.app, surface: t.panel, foreground: t.ink, accent: t.accent, primary: t.primary, selection: t.selection, focus: t.focus,
    error: t["error-ink"], warning: t["warn-ink"], success: t["ok-ink"], info: t.info});
  function defaultSyntax(type) {
    return type === "dark" || type === "hc-dark"
      ? {keyword: "#c586c0", string: "#ce9178", number: "#b5cea8", comment: "#8f9f8f", function: "#dcdcaa", type: "#4ec9b0", variable: "#9cdcfe", operator: "#d4d4d4", constant: "#4fc1ff", punctuation: "#cccccc"}
      : {keyword: "#9b2393", string: "#a31515", number: "#116644", comment: "#5a6e5a", function: "#795e26", type: "#1f6f7a", variable: "#001080", operator: "#333333", constant: "#0451a5", punctuation: "#444444"};
  }

  // ------------------------------------------------------------------ built-in themes
  // Original themes (docs/themes.md). Each passes tests/css-tokens.py: text 4.5:1 on its surfaces,
  // and copper layers at least the ΔE floor apart (deuteranopia-checked for Clearview).
  const BUILTIN = [
    {id: "ember", name: "Ember", type: "dark", description: "Warm charcoal with an amber accent, for long evening sessions.",
      palette: {background: "#1a1613", surface: "#2a231e", foreground: "#ece2d6", accent: "#f2a65a", primary: "#a8521c", selection: "#5a3b22", focus: "#e8a15c",
        error: "#ff8a75", warning: "#f2c46d", success: "#9fd38f", info: "#8cc4f0"},
      colors: {"canvas-bg": "#100d0b"},
      canvas: {pcb: {system: {workspace: "#241e1a", board: "#0d0a08", boardGrid: "#1f1915", boardGridCoarse: "#33291f", edge: "#c9a77f", connection: "#d6c3ad", dim: "#4d4239"},
        layers: {Top: "#ff5a3c", Bottom: "#4f8dff", "Inner 1": "#e8b100", "Inner 2": "#5fd6c4", "Inner 3": "#a5e05a", "Inner 4": "#c58bff", "Inner 5": "#ff9ecb", "Inner 6": "#9f6a3a", Silk: "#fff2c4", "Bottom silk": "#a39062"}},
        sch: {workspace: "#6f6259", paper: "#fff8ee", grid: "#ece2d2"}},
      syntax: {keyword: "#f2a65a", string: "#d7c27a", number: "#e8a0a0", comment: "#9a8b7c", function: "#f0d080", type: "#8fd0b8", variable: "#ece2d6", constant: "#ffb38a"}},
    {id: "fjord", name: "Fjord", type: "dark", description: "Cool blue slate with a glacial cyan accent.",
      palette: {background: "#11161d", surface: "#1b232e", foreground: "#dbe5f0", accent: "#4fd1e0", primary: "#2b6cb0", selection: "#24476b", focus: "#5ab0ff",
        error: "#ff8080", warning: "#f5c76a", success: "#7ad7a0", info: "#7cc4ff"},
      colors: {"canvas-bg": "#0a0e13"},
      canvas: {pcb: {system: {workspace: "#18202a", board: "#070a0e", boardGrid: "#141b24", boardGridCoarse: "#222c38", edge: "#8fb0cc", connection: "#b8c8d8", dim: "#3b4652"},
        layers: {Top: "#ff6b5e", Bottom: "#3b8bff", "Inner 1": "#ffc94a", "Inner 2": "#4fe0c8", "Inner 3": "#b4e85c", "Inner 4": "#b18cff", "Inner 5": "#ff8fd0", "Inner 6": "#7a8aa0", Silk: "#f2f6ff", "Bottom silk": "#8a96a8"}},
        sch: {workspace: "#55606e", paper: "#fbfcff", grid: "#e2e8f0"}},
      syntax: {keyword: "#82aaff", string: "#a5e3a0", number: "#f7a072", comment: "#7f8fa3", function: "#7fdbca", type: "#ffcb6b", variable: "#dbe5f0", constant: "#f78c9b"}},
    {id: "obsidian", name: "Obsidian", type: "dark", description: "True black for OLED displays: pixels off wherever nothing is drawn.",
      palette: {background: "#000000", surface: "#000000", foreground: "#e6e6e6", accent: "#b48cff", primary: "#5b3fbf", selection: "#2a1f4d", focus: "#a98bff",
        error: "#ff7a70", warning: "#ffc861", success: "#6fdc8c", info: "#79b8ff"},
      colors: {chrome: "#000000", "panel-head": "#0d0d0d", hover: "#141414", raised: "#1c1c1c", pressed: "#242424", field: "#0a0a0a", "menu-bg": "#0a0a0a",
        "tab-bg": "#000000", "tab-hover": "#121212", line: "#262626", "line-strong": "#3a3a3a", divider: "#1f1f1f", soft: "#0a0a0a", "canvas-bg": "#000000",
        button: "#111111", "button-hover": "#1c1c1c", "button-line": "#717171", "input-line": "#686868", rule: "#1a1a1a", "layer-on": "#1c1c1c", "ls-bg": "#000000"},
      canvas: {pcb: {system: {workspace: "#000000", workspaceGrid: "#0e0e0e", workspaceGridCoarse: "#1a1a1a", board: "#000000", boardGrid: "#121212", boardGridCoarse: "#222222", edge: "#8c8c8c", dim: "#3a3a3a"},
        layers: {Top: "#ff4d4d", Bottom: "#4d7cff", "Inner 1": "#e6b800", "Inner 2": "#40d9ff", "Inner 3": "#33d17a", "Inner 4": "#b78cff", "Inner 5": "#ff8ad8", "Inner 6": "#a0a0a0"}},
        sch: {workspace: "#1a1a1a", paper: "#f2f2f2", grid: "#dddddd"}},
      syntax: {keyword: "#c4a0ff", string: "#9fe0a0", number: "#ffb070", comment: "#8a8a8a", function: "#ffe08a", type: "#7fd8e8", variable: "#e6e6e6", constant: "#ff9eb0"}},
    {id: "haze", name: "Haze", type: "light", description: "A soft, low-glare light theme: warm grey surfaces instead of white.",
      palette: {background: "#e4e1dc", surface: "#efece7", foreground: "#2b2a28", accent: "#9a4f16", primary: "#3d6aa8", selection: "#d6dfe9", focus: "#2f6fbf",
        error: "#b3261e", warning: "#7a5200", success: "#1f6e35", info: "#225e9c"},
      colors: {field: "#f7f5f1", "menu-bg": "#f5f3ef", "canvas-bg": "#2a2826"},
      canvas: {pcb: {system: {workspace: "#3a3835", board: "#14130f"}}, sch: {workspace: "#b9b4ab", paper: "#fbf8f2", grid: "#e6e0d4"}},
      syntax: {keyword: "#8a2f8a", string: "#8a4a12", number: "#1d6e48", comment: "#6a675f", function: "#6a4a00", type: "#1f5f73", variable: "#2b2a28", constant: "#2a4f9a"}},
    {id: "vellum", name: "Vellum", type: "light", description: "Paper and ink: a print-like page with a light board, for review and screenshots.",
      palette: {background: "#e8e3d8", surface: "#f6f2e9", foreground: "#1b1a17", accent: "#a3241b", primary: "#a3241b", selection: "#ead9c2", focus: "#7d3f12",
        error: "#a3241b", warning: "#6e4a00", success: "#245f2e", info: "#1f4f8a"},
      colors: {field: "#fffdf8", "menu-bg": "#fffcf5", "canvas-bg": "#f2eee4", "layer-on": "#fffdf8"},
      canvas: {pcb: {system: {workspace: "#d8d2c4", workspaceGrid: "#cfc8b9", workspaceGridCoarse: "#c4bcab", board: "#f8f5ec", boardGrid: "#ece6d8", boardGridCoarse: "#ddd5c3",
          edge: "#3a352c", hole: "#7a6a4a", padHole: "#4a6a7a", drillEdge: "#5a5448", dim: "#c9c2b2", selection: "#0a0a0a", connection: "#6a6455", origin: "#3a352c", padText: "#000001"},
        layers: {Top: "#c0261b", Bottom: "#1f4fa8", "Inner 1": "#8a6400", "Inner 2": "#00838f", "Inner 3": "#2e7d32", "Inner 4": "#6a3fb5", "Inner 5": "#c2185b", "Inner 6": "#5d4037",
          Silk: "#1b1a17", "Bottom silk": "#7a7464", Multi: "#5a5a5a", "Top mask": "#7a3b8a", "Bottom mask": "#b0478f", "Top paste": "#6f6f6f", "Bottom paste": "#7a3a2a", "Mechanical 1": "#8a2a8a", "Mechanical 15": "#4a5a9a"}},
        sch: {workspace: "#d8d2c4", paper: "#fffdf8", grid: "#ebe5d8"}},
      syntax: {keyword: "#a3241b", string: "#6e4a00", number: "#245f2e", comment: "#6b665b", function: "#1f4f8a", type: "#5d3a8a", variable: "#1b1a17", constant: "#8a3a00"}},
    {id: "clearview", name: "Clearview", type: "dark", description: "Colour-vision friendly: copper layers chosen to stay apart with deuteranopia (and protanopia).",
      palette: {background: "#16181c", surface: "#23262c", foreground: "#e4e6ea", accent: "#e69f00", primary: "#0b6aa8", selection: "#2b4a66", focus: "#56b4e9",
        error: "#ff9b6b", warning: "#f0e442", success: "#5fc4a8", info: "#56b4e9"},
      colors: {"canvas-bg": "#0b0c0e"},
      canvas: {pcb: {system: {workspace: "#2a2d33", board: "#000000", edge: "#bfbfbf", dim: "#4a4d52"},
        // Orange and blue (Okabe–Ito) outer layers; inner layers chosen for the largest ΔE under simulated deuteranopia.
        layers: {Top: "#e69f00", Bottom: "#3d8ee6", "Inner 1": "#00f0b4", "Inner 2": "#6a4dff", "Inner 3": "#cc2a8a", "Inner 4": "#5a8a00", "Inner 5": "#88eeff", "Inner 6": "#ddee88",
          Silk: "#ffffff", "Bottom silk": "#9a9a9a", Multi: "#c8c8c8"}},
        sch: {workspace: "#5c6068", paper: "#fffcf8", grid: "#e6e3dc"}},
      syntax: {keyword: "#e69f00", string: "#56b4e9", number: "#f0e442", comment: "#9a9ea6", function: "#cc79a7", type: "#5fc4a8", variable: "#e4e6ea", constant: "#ffb070"}},
    {id: "hc-light", name: "High Contrast Light", type: "hc-light", description: "Black on white with strong outlines and a red focus ring.",
      palette: {background: "#ffffff", surface: "#ffffff", foreground: "#000000", accent: "#8a3b00", primary: "#0f4a85", selection: "#cfe0f5", focus: "#b5200d", border: "#0f4a85",
        error: "#a1160d", warning: "#5c3d00", success: "#0b5a1e", info: "#0b4a8a"},
      colors: {"panel-head": "#f0f0f0", hover: "#e8eef6", raised: "#dfe7f1", pressed: "#d0dbe9", "tab-bg": "#ffffff", "tab-hover": "#e8eef6", "selection-ink": "#000000",
        "sel-sub-ink": "#1a2a3d", muted: "#262626", faint: "#3d3d3d", "canvas-bg": "#000000", "ls-bg": "#ffffff", "layer-on": "#ffffff", rule: "#0f4a85"},
      canvas: {pcb: {system: {workspace: "#000000", workspaceGrid: "#1c1c1c", workspaceGridCoarse: "#2e2e2e", edge: "#ffffff", connection: "#e6e6e6"}},
        sch: {workspace: "#ffffff", paper: "#ffffff", grid: "#d0d0d0"}},
      syntax: {keyword: "#7a1b8a", string: "#7a2a00", number: "#0b5a1e", comment: "#3d3d3d", function: "#5c3d00", type: "#0b4a6a", variable: "#000000", constant: "#0b3a8a"}},
    {id: "soldermask", name: "Soldermask", type: "dark", description: "Just for fun: a green solder-mask workbench with gold copper and white silk.",
      palette: {background: "#06291a", surface: "#0c3b25", foreground: "#e8f3e9", accent: "#f2c14e", primary: "#1f7a4a", selection: "#1d5c3a", focus: "#f2c14e",
        error: "#ff8f80", warning: "#f6d36b", success: "#9be3a6", info: "#8fd0ff"},
      colors: {"canvas-bg": "#03170e"},
      canvas: {pcb: {system: {workspace: "#0a3320", workspaceGrid: "#0e3a25", workspaceGridCoarse: "#13442c", board: "#0b5d2e", boardGrid: "#0e6533", boardGridCoarse: "#137040",
          edge: "#e8f3e9", hole: "#c9b27a", padHole: "#2c2c2c", drillEdge: "#b8c8b8", dim: "#2f6a47", connection: "#d8f0dc", origin: "#ffffff"},
        layers: {Top: "#ffcf4d", Bottom: "#ff7a3d", "Inner 1": "#44aaff", "Inner 2": "#00ffcc", "Inner 3": "#ffaaff", "Inner 4": "#c0c890", "Inner 5": "#9cff7a", "Inner 6": "#ffffff",
          Silk: "#ffffff", "Bottom silk": "#bcd9c3", Multi: "#d9c38a", "Top mask": "#37a86a", "Bottom mask": "#2f8f5c"}},
        sch: {workspace: "#2d5a40", paper: "#fbfff9", grid: "#e1eee3"}},
      syntax: {keyword: "#f2c14e", string: "#bfe8a0", number: "#ffb38a", comment: "#8fb89a", function: "#ffe08a", type: "#8fd0ff", variable: "#e8f3e9", constant: "#ff9fb0"},
      iconTint: "#d8ecd9"}
  ].map(d => Object.freeze({"atrium-theme": FORMAT, ...d}));
  const BUILTIN_IDS = Object.freeze(BUILTIN.map(d => d.id));

  function add(id, doc, source, extra) { registry.set(id, {id, doc, source, ...extra}); resolved.delete(id); }
  for (const id of T.PRESET_IDS) add(id, Object.freeze(legacyDoc(id)), "builtin", {legacy: true});
  for (const d of BUILTIN) add(d.id, d, "builtin");
  const docOf = id => registry.get(id)?.doc || null;
  function resolvedOf(id) {
    if (!resolved.has(id)) { const d = docOf(id); if (!d) return null; resolved.set(id, resolve(d)); }
    return resolved.get(id);
  }
  // The colours AtriumTheme applies and caches for a theme id (legacy presets use their CSS blocks).
  function entryFor(id) {
    if (T.PRESETS[id]) return null;
    const r = resolvedOf(id); if (!r) return null;
    const pcb = {...r.canvas.pcb.system, layers: {...r.canvas.pcb.layers}};
    return {name: r.name, base: r.base, family: r.family, scheme: r.scheme, tokens: {...r.tokens}, syntax: {...r.syntax}, pcb, sch: {...r.canvas.sch}};
  }
  function list({family} = {}) {
    const out = [];
    for (const e of registry.values()) {
      if (e.id.startsWith("user:__")) continue;
      const type = e.doc.type, fam = type === "dark" || type === "hc-dark" ? "dark" : "light";
      if (family && fam !== family) continue;
      out.push({id: e.id, name: e.doc.name, type, family: fam, source: e.source, ext: e.ext || null, description: e.doc.description || ""});
    }
    const rank = {builtin: 0, extension: 1, user: 2};
    return out.sort((a, b) => rank[a.source] - rank[b.source] || (a.source === "builtin" ? 0 : a.name.localeCompare(b.name)));
  }

  // ------------------------------------------------------------------ user and extension themes
  const USER = "atrium.themes.user";
  const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };
  function loadUser() {
    let rows = [];
    try { rows = JSON.parse(store()?.getItem(USER) || "[]"); } catch {}
    for (const row of Array.isArray(rows) ? rows.slice(0, MAX_USER) : []) {
      if (!row || typeof row.id !== "string" || !/^user:[\w.-]{1,64}$/.test(row.id)) continue;
      const v = validate(row.doc);
      if (v.ok) add(row.id, Object.freeze(v.doc), "user");
    }
  }
  function saveUserStore() {
    const rows = [...registry.values()].filter(e => e.source === "user").map(e => ({id: e.id, doc: e.doc}));
    try { store()?.setItem(USER, JSON.stringify(rows)); } catch {}
  }
  const slug = s => String(s || "theme").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";
  // Save (or replace) a theme of the user's own; returns its id.
  function saveUser(input, id) {
    const v = validate(input);
    if (!v.ok) throw Error(v.errors.join(" "));
    if (id != null && !/^user:[\w.-]{1,64}$/.test(id)) throw Error("A user theme id starts with user:.");
    if (!id) { const base = "user:" + slug(v.doc.name); id = base; for (let n = 2; registry.has(id); n++) id = base + "-" + n; }
    if (!registry.has(id) && [...registry.values()].filter(e => e.source === "user").length >= MAX_USER) throw Error("At most " + MAX_USER + " themes of your own; remove one first.");
    add(id, Object.freeze(v.doc), "user"); saveUserStore(); refreshApplied(id);
    return id;
  }
  function removeUser(id) {
    const e = registry.get(id); if (!e || e.source !== "user") return false;
    registry.delete(id); resolved.delete(id); saveUserStore();
    if (T.effectivePreset() === id) T.set({preset: e.doc.type === "light" || e.doc.type === "hc-light" ? "light" : "dark"});
    return true;
  }
  // Extensions contribute themes as data only (contributes.themes): no code runs for them. Each
  // entry is a Waffle theme document or a VS Code colour theme (converted when the importer is loaded).
  function registerExtension(extId, themes) {
    unregisterExtension(extId, true);
    const ids = [], errors = [];
    if (!/^[\w.-]{1,80}$/.test(String(extId))) return {ids, errors: ["Bad extension id."]};
    for (const t of (Array.isArray(themes) ? themes : []).slice(0, 20)) {
      try {
        const local = String(t?.id || slug(t?.label || t?.theme?.name));
        if (!ID.test(local)) throw Error("theme ids are letters, digits, '.', '_' or '-'");
        let doc = t?.theme;
        if (doc && !("atrium-theme" in doc)) doc = vscodeDoc(doc, t.label);
        if (doc && t.label && !doc.name) doc = {...doc, name: t.label};
        const v = validate(doc);
        if (!v.ok) throw Error(v.errors[0]);
        const id = "ext:" + extId + "/" + local;
        add(id, Object.freeze(v.doc), "extension", {ext: extId}); ids.push(id);
      } catch (e) { errors.push((t?.id || t?.label || "theme") + ": " + e.message); }
    }
    for (const id of ids) refreshApplied(id);
    return {ids, errors};
  }
  function unregisterExtension(extId, quiet) {
    let n = 0;
    for (const [id, e] of [...registry]) if (e.source === "extension" && e.ext === extId) { registry.delete(id); resolved.delete(id); n++; }
    if (!quiet && n && /^ext:/.test(T.effectivePreset()) && !registry.has(T.effectivePreset())) T.set({preset: T.get().systemDark && registry.has(T.get().systemDark) ? T.get().systemDark : "dark"});
    return n;
  }
  function vscodeDoc(json, label) {
    const V = globalThis.AtriumVSCode;
    if (!V?.toDocument) throw Error("VS Code themes need the importer; reload the extension.");
    return V.toDocument(json, {name: label}).doc;
  }
  // When the theme in use changes (edited, or its extension updated), re-apply it.
  function refreshApplied(id) {
    const s = T.get();
    if ([T.effectivePreset(), s.systemLight, s.systemDark].includes(id)) { T.register(id, entryFor(id)); if (T.effectivePreset() === id) T.apply(); }
  }

  // ------------------------------------------------------------------ import and export
  // A self-contained document: every token, the canvas palettes and syntax colours.
  function themeDocument(id, {flatten = true} = {}) {
    const d = docOf(id); if (!d) return null;
    if (!flatten) return JSON.parse(JSON.stringify(d));
    const r = resolvedOf(id), colors = {};
    for (const k of T.TOKENS) if (hex(r.tokens[k])) colors[k] = r.tokens[k];
    const out = {"atrium-theme": FORMAT, name: d.name, type: r.type};
    for (const k of ["author", "description"]) if (d[k]) out[k] = d[k];
    out.colors = colors;
    out.canvas = {pcb: {system: {...r.canvas.pcb.system}, layers: {...r.canvas.pcb.layers}}, sch: {...r.canvas.sch}};
    if (!Object.keys(out.canvas.pcb.layers).length) delete out.canvas.pcb.layers;
    out.syntax = {...r.syntax};
    if (d.iconTint) out.iconTint = d.iconTint;
    return out;
  }
  const exportJSON = id => JSON.stringify(themeDocument(id), null, 2) + "\n";
  // A self-contained document from an unsaved one (the theme editor's Export).
  function flatten(input) {
    const v = validate(input); if (!v.ok) throw Error(v.errors.join(" "));
    const PREVIEW = "user:__flatten"; add(PREVIEW, Object.freeze(v.doc), "user");
    try { return themeDocument(PREVIEW); } finally { registry.delete(PREVIEW); resolved.delete(PREVIEW); }
  }
  // Show an unsaved document live (the theme editor); nothing is stored. Returns its resolution.
  const PREVIEW_ID = "user:__preview";
  function preview(input) {
    const v = validate(input); if (!v.ok) throw Error(v.errors.join(" "));
    add(PREVIEW_ID, Object.freeze(v.doc), "user");
    const e = entryFor(PREVIEW_ID); T.register(PREVIEW_ID, e, false);
    if (T.effectivePreset() !== PREVIEW_ID) T.set({preset: PREVIEW_ID}, {persist: false, reason: "preview"}); else T.apply();
    const r = resolvedOf(PREVIEW_ID); registry.delete(PREVIEW_ID);
    return r;
  }
  // Waffle theme JSON, a Waffle appearance-settings file, or a VS Code colour theme (JSON with
  // comments). Returns the saved user theme, or {settings:true} for a settings file.
  async function importText(text, {select: choose = true} = {}) {
    if (typeof text !== "string") throw Error("A theme file is text.");
    if (text.length > MAX_TEXT) throw Error("The theme file is larger than " + (MAX_TEXT / 1024) + " KB.");
    let data = null;
    try { data = JSON.parse(text.replace(/^﻿/, "")); } catch {}
    if (data && typeof data === "object" && data["atrium-theme"] != null && ("type" in data || "colors" in data || "palette" in data || "extends" in data)) {
      const v = validate(data);
      if (!v.ok) throw Error(v.errors.slice(0, 6).join(" "));
      const id = saveUser(v.doc);
      if (choose) select(id);
      return {id, doc: v.doc, report: resolvedOf(id).report, warnings: v.warnings};
    }
    if (data && typeof data === "object" && data["atrium-theme"] != null) { T.importJSON(text); return {settings: true}; }
    const L = globalThis.AtriumLazy, V = globalThis.AtriumVSCode || (L ? await L.need("AtriumVSCode") : null);
    if (!V) throw Error("The VS Code importer is not available.");
    const r = V.toDocument(text);
    const id = saveUser(r.doc);
    if (choose) select(id);
    return {id, doc: r.doc, report: resolvedOf(id).report, warnings: r.report.warnings, vscode: true};
  }
  // Use a theme. When the OS light/dark setting is followed, a theme of the current kind becomes
  // that kind's preferred theme; one of the other kind stops the following (so the choice shows).
  function select(id, {persist = true, reason = "change"} = {}) {
    if (!registry.has(id)) throw Error("Unknown theme " + id + ".");
    const e = entryFor(id); if (e) T.register(id, e);
    const s = T.get(), fam = familyOf(id);
    if (s.followSystem && fam === T.PRESETS[T.baseOf(T.effectivePreset())]?.family)
      return T.set({followSystem: true, [fam === "light" ? "systemLight" : "systemDark"]: id, tokens: {}}, {persist, reason});
    return T.set({preset: id}, {persist, reason});
  }
  const familyOf = id => { const t = docOf(id)?.type; return t === "light" || t === "hc-light" ? "light" : "dark"; };

  // ------------------------------------------------------------------ boot
  loadUser();
  T.useResolver?.(entryFor);
  // Themes the settings name are registered with AtriumTheme (and cached for the next start).
  try { const s = T.get(); for (const id of new Set([T.effectivePreset(), s.preset, s.systemLight, s.systemDark])) { const e = entryFor(id); if (e) T.register(id, e); } T.apply(); } catch {}

  return Object.freeze({FORMAT, TYPES, PALETTE, SYNTAX, SYSTEM, NAMED_LAYERS, COPPER, TEXT: CONTRAST, BUILTIN_IDS, validate, derive, resolve, layerReport, deltaE, deuteranopia, lab,
    list, has: id => registry.has(id), get: id => registry.get(id) || null, document: themeDocument, resolved: resolvedOf, entryFor, familyOf, exportJSON, importText, select,
    flatten, preview, PREVIEW_ID, saveUser, removeUser, registerExtension, unregisterExtension, builtin: () => BUILTIN.slice(), legacyDoc});
})();
