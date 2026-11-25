"use strict";
// AtriumVSCode: VS Code colour themes and keybindings for Waffle (loaded on first use, from
// Preferences or the command palette).
//
//   AtriumVSCode.parseJSONC(text)                  JSON with // and /* */ comments and trailing commas
//   AtriumVSCode.convert(themeJSON|text, {canvas})  -> {settings, tokens, report, canvas?}
//   AtriumVSCode.applyTheme(themeJSON|text, {canvas})  convert and apply (AtriumTheme.set)
//   AtriumVSCode.toDocument(themeJSON|text, {canvas, name}) -> {doc, report}  an atrium-theme v1 document
//   AtriumVSCode.importAsTheme(themeJSON|text, {canvas})   save it as a user theme and use it
//   AtriumVSCode.readVsix(arrayBuffer)             -> Promise<[{label, uiTheme, json}]>
//   AtriumVSCode.planKeybindings(text)             -> {rows, mac}   (nothing changes)
//   AtriumVSCode.applyKeybindings(plan, {skipConflicts})  -> {applied, skipped, conflicts}
//   AtriumVSCode.EXAMPLES                          three built-in themes in VS Code's format
//   AtriumVSCode.themeDialog() / keysDialog()      the import dialogs
//
// Theme mapping: workbench colours (editor, side bar, activity bar, title and status bars, tabs,
// lists, focus border, buttons, inputs, menus, notifications…) map onto Waffle's tokens; tokens
// the theme does not set are derived from the ones it does. Every text colour is checked against
// its background (WCAG 2.x: 4.5:1 for text, 3:1 for focus rings and markers); a derived colour is
// nudged until it passes, and a colour the theme sets explicitly is nudged too with a warning
// (pass {fix:false} to keep it and only warn). Translucent colours are composited over the
// surface they sit on.
//
// Canvas: by default the PCB and schematic palettes are left alone. With {canvas:true} the
// theme's syntax colours (tokenColors) become a copper layer set: top copper takes the warmest
// hue, bottom copper the coolest (at least 90° apart), inner layers the rest, all at 3:1 or more
// on the board and clearly below the white selection colour.
globalThis.AtriumVSCode = (() => {
  const T = () => globalThis.AtriumTheme;
  const C = () => T().color;

  // ------------------------------------------------------------------ JSONC
  // Comments are removed and trailing commas dropped, outside strings only.
  function stripJSONC(text) {
    const s = String(text ?? "").replace(/^﻿/, ""), n = s.length, out = [];
    // Plain runs are copied as one slice (no per-character array: a big file stays ~2x its size).
    let i = 0, from = 0;
    const cut = to => { if (to > from) out.push(s.slice(from, to)); };
    while (i < n) {
      const c = s[i];
      if (c !== '"' && c !== "/" && c !== ",") { i++; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < n && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
        i = j + 1; continue;
      }
      if (c === "/" && s[i + 1] === "/") { cut(i); while (i < n && s[i] !== "\n") i++; from = i; continue; }
      if (c === "/" && s[i + 1] === "*") { cut(i); const e = s.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; out.push(" "); from = i; continue; }
      if (c === ",") {
        let j = i + 1;
        for (;;) {
          while (j < n && /\s/.test(s[j])) j++;
          if (s[j] === "/" && s[j + 1] === "/") { while (j < n && s[j] !== "\n") j++; continue; }
          if (s[j] === "/" && s[j + 1] === "*") { const e = s.indexOf("*/", j + 2); j = e < 0 ? n : e + 2; continue; }
          break;
        }
        if (s[j] === "}" || s[j] === "]") { cut(i); i++; from = i; continue; }
      }
      i++;
    }
    cut(n);
    return out.join("");
  }
  function parseJSONC(text) {
    const src = stripJSONC(text);
    try { return JSON.parse(src); }
    catch (e) {
      const m = /position (\d+)/.exec(e.message), at = m ? +m[1] : -1;
      const line = at >= 0 ? src.slice(0, at).split("\n").length : 0;
      throw Error("This is not valid JSON" + (line ? " (line " + line + ")" : "") + ".");
    }
  }

  // ------------------------------------------------------------------ colour helpers
  const isColor = v => typeof v === "string" && !!C().rgba(v);
  const dark = c => C().luminance(c) < .18;
  function hsl(color) {
    const [r, g, b] = C().rgba(color).map((v, i) => i < 3 ? v / 255 : v), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function fromHsl(h, s, l) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return "#" + [f(0), f(8), f(4)].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
  }
  const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  // CIE76 distance in Lab: about 2.3 is a just-noticeable difference.
  function lab(color) {
    const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    const [r, g, b] = C().rgba(color).slice(0, 3).map(lin);
    const xyz = [(r * .4124 + g * .3576 + b * .1805) / .95047, r * .2126 + g * .7152 + b * .0722, (r * .0193 + g * .1192 + b * .9505) / 1.08883];
    const f = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116, [x, y, z] = xyz.map(f);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const ratio = (a, b) => +C().contrast(a, b).toFixed(2);
  // Raise contrast: move away from the background, and failing that use the better extreme.
  function legible(fg, bg, min) {
    const c = C();
    let out = c.ensureContrast(fg, bg, min);
    if (c.contrast(out, bg) < min) out = c.bestInk(bg);
    return out;
  }

  // ------------------------------------------------------------------ theme kind
  const UI_THEME = {vs: "light", "vs-dark": "dark", "hc-black": "hc", "hc-light": "hcLight"};
  function kindOf(data, colors) {
    const t = String(data.type || data.uiTheme || "").toLowerCase();
    if (UI_THEME[t]) return UI_THEME[t];
    if (t === "hcdark" || t === "hc") return "hc";
    if (t === "hclight") return "hcLight";
    if (t === "dark" || t === "light") return t;
    const bg = colors["editor.background"];
    return isColor(bg) && !dark(C().hex(bg)) ? "light" : "dark";
  }

  // ------------------------------------------------------------------ workbench -> tokens
  // Text pairs checked after mapping: [token, background token, minimum ratio].
  const TEXT = [
    ["ink", "panel", 4.5], ["ink", "app", 4.5], ["ink", "field", 4.5], ["ink", "menu-bg", 4.5], ["ink", "hover", 4.5], ["ink", "button", 4.5], ["ink", "raised", 4.5],
    ["muted", "panel", 4.5], ["faint", "panel", 4.5], ["selection-ink", "selection", 4.5], ["sel-sub-ink", "selection", 4.5],
    ["on-primary", "primary", 4.5], ["on-accent", "accent", 4.5], ["accent-btn-ink", "accent", 4.5], ["accent", "panel", 4.5],
    ["chrome-ink", "chrome", 4.5], ["coords-ink", "chrome", 4.5], ["dim-ink", "chrome", 4.5], ["tool-ink", "chrome", 4.5],
    ["tab-ink", "tab-bg", 4.5], ["tab-hover-ink", "tab-hover", 4.5], ["ink-bright", "panel-head", 4.5], ["ink-bright", "layer-on", 4.5], ["head-ink", "panel-head", 4.5],
    ["icon-ink", "panel", 4.5], ["caption-ink", "panel", 4.5], ["split-ink", "panel", 4.5], ["soft-ink", "panel", 4.5], ["ink-strong", "panel", 4.5],
    ["error-ink", "panel", 4.5], ["warn-ink", "panel", 4.5], ["ok-ink", "panel", 4.5], ["bad-ink", "panel", 4.5], ["km-warn", "panel", 4.5],
    ["diff-changed", "panel", 4.5], ["diff-added", "panel", 4.5], ["diff-removed", "panel", 4.5], ["ls-ink", "ls-bg", 4.5],
    ["danger", "panel", 4.5], ["warning", "panel", 4.5], ["info", "panel", 4.5], ["on-danger", "danger-fill", 4.5],
    ["focus", "panel", 3], ["err-mark", "panel", 3], ["warn-mark", "panel", 3], ["ok-mark", "panel", 3], ["icon-folder", "panel", 3], ["icon-sch", "panel", 3], ["icon-pcb", "panel", 3]
  ];
  // [Waffle token, VS Code keys in order of preference, the surface it is composited over].
  const MAP = [
    ["canvas-bg", ["editor.background"], null],
    ["panel", ["sideBar.background", "panel.background", "editor.background"], "canvas-bg"],
    ["ink", ["foreground", "sideBar.foreground", "editor.foreground"], "panel"],
    ["chrome", ["titleBar.activeBackground", "activityBar.background", "editorGroupHeader.tabsBackground"], "panel"],
    ["app", ["editorGroupHeader.tabsBackground", "activityBar.background", "titleBar.activeBackground"], "panel"],
    ["panel-head", ["sideBarSectionHeader.background", "panelSectionHeader.background", "tab.activeBackground"], "panel"],
    ["raised", ["editorWidget.background", "dropdown.background"], "panel"],
    ["hover", ["list.hoverBackground"], "panel"],
    ["field", ["input.background"], "panel"],
    ["menu-bg", ["menu.background", "dropdown.background", "editorWidget.background"], "panel"],
    ["tab-bg", ["tab.inactiveBackground", "editorGroupHeader.tabsBackground"], "app"],
    ["tab-hover", ["tab.hoverBackground", "tab.activeBackground"], "tab-bg"],
    ["muted", ["descriptionForeground"], "panel"],
    ["faint", ["disabledForeground"], "panel"],
    ["line", ["panel.border", "sideBar.border", "editorGroup.border", "widget.border", "contrastBorder"], "panel"],
    ["line-strong", ["contrastBorder", "input.border", "dropdown.border", "editorWidget.border"], "panel"],
    ["divider", ["sideBar.border", "editorGroup.border", "panel.border", "contrastBorder"], "app"],
    ["accent", ["activityBar.activeBorder", "tab.activeBorderTop", "tab.activeBorder", "panelTitle.activeBorder", "progressBar.background", "button.background", "focusBorder"], "panel"],
    ["selection", ["list.activeSelectionBackground", "list.inactiveSelectionBackground", "editor.selectionBackground"], "panel"],
    ["selection-ink", ["list.activeSelectionForeground", "list.inactiveSelectionForeground"], "selection"],
    ["focus", ["focusBorder"], "panel"],
    ["primary", ["button.background"], "panel"],
    ["on-primary", ["button.foreground"], "primary"],
    ["primary-line", ["button.border"], "panel"],
    ["button", ["button.secondaryBackground"], "panel"],
    ["button-hover", ["button.secondaryHoverBackground"], "panel"],
    ["button-line", ["button.border", "contrastBorder"], "panel"],
    ["input-line", ["input.border", "dropdown.border"], "panel"],
    ["bar-line", ["editorWidget.border", "widget.border", "menu.border"], "panel"],
    ["pressed", ["toolbar.activeBackground", "inputOption.activeBackground"], "panel"],
    ["head-ink", ["sideBarSectionHeader.foreground", "sideBarTitle.foreground"], "panel-head"],
    ["tab-ink", ["tab.inactiveForeground"], "tab-bg"],
    ["tab-hover-ink", ["tab.activeForeground"], "tab-hover"],
    ["chrome-ink", ["titleBar.activeForeground", "activityBar.foreground"], "chrome"],
    ["tool-ink", ["icon.foreground", "activityBar.foreground"], "chrome"],
    ["dim-ink", ["activityBar.inactiveForeground", "titleBar.inactiveForeground"], "chrome"],
    ["coords-ink", ["titleBar.activeForeground", "foreground"], "chrome"],
    ["icon-ink", ["icon.foreground"], "panel"],
    ["error-ink", ["errorForeground", "list.errorForeground", "editorError.foreground"], "panel"],
    ["warn-ink", ["list.warningForeground", "editorWarning.foreground"], "panel"],
    ["ok-ink", ["testing.iconPassed", "terminal.ansiGreen", "gitDecoration.addedResourceForeground"], "panel"],
    ["info", ["editorInfo.foreground", "notificationsInfoIcon.foreground", "editorOverviewRuler.infoForeground"], "panel"],
    ["diff-changed", ["gitDecoration.modifiedResourceForeground", "editorGutter.modifiedBackground"], "panel"],
    ["diff-added", ["gitDecoration.addedResourceForeground", "gitDecoration.untrackedResourceForeground", "editorGutter.addedBackground"], "panel"],
    ["diff-removed", ["gitDecoration.deletedResourceForeground", "editorGutter.deletedBackground"], "panel"],
    ["err-mark", ["editorError.foreground", "editorOverviewRuler.errorForeground"], "panel"],
    ["warn-mark", ["editorWarning.foreground", "editorOverviewRuler.warningForeground"], "panel"],
    ["ok-mark", ["testing.iconPassed", "terminal.ansiGreen"], "panel"],
    ["icon-folder", ["symbolIcon.folderForeground"], "panel"],
    ["shadow-md", ["widget.shadow"], null]
  ];
  // Shades for tokens nothing maps to, from the mapped surfaces and ink.
  function derived(t, k) {
    const c = C(), mix = c.mix, black = "#000000";
    const toward = (a, x) => mix(a, t.ink, x), deeper = (a, x) => mix(a, black, x);
    switch (k) {
      case "panel": return t["canvas-bg"];
      case "chrome": return mix(t.panel, black, t._dark ? .08 : .04);
      case "app": return deeper(t.chrome, t._dark ? .2 : .06);
      case "panel-head": return toward(t.panel, .07);
      case "raised": return toward(t.panel, .12);
      case "hover": return toward(t.panel, .07);
      case "field": return t._dark ? deeper(t.panel, .25) : "#ffffff";
      case "menu-bg": return t.raised && c.contrast(t.raised, t.panel) < 1.4 ? t.raised : toward(t.panel, .04);
      case "tab-bg": return mix(t.app, t.panel, .4);
      case "tab-hover": return toward(t["tab-bg"], .06);
      case "ink": return t._dark ? "#d4d4d4" : "#1f1f1f";
      case "muted": return mix(t.ink, t.panel, .3);
      case "faint": return mix(t.ink, t.panel, .42);
      case "line": return toward(t.panel, .14);
      case "line-strong": return toward(t.panel, .26);
      case "divider": return t.app;
      case "selection": return mix(t.panel, t.accent, t._dark ? .4 : .25);
      case "selection-ink": return c.bestInk(t.selection, t._dark ? "#141414" : t.ink, t._dark ? "#ffffff" : "#ffffff");
      case "focus": return t.accent;
      case "primary": return t.accent;
      case "on-primary": return c.bestInk(t.primary, "#141414", "#ffffff");
      case "primary-line": return toward(t.primary, .18);
      case "button": return toward(t.panel, .1);
      case "button-hover": return toward(t.button, .08);
      case "button-line": return toward(t.panel, .24);
      case "input-line": return t["line-strong"];
      case "bar-line": return t["line-strong"];
      case "pressed": return toward(t.panel, .16);
      case "head-ink": return t.ink;
      case "tab-ink": return mix(t.ink, t["tab-bg"], .22);
      case "tab-hover-ink": return t.ink;
      case "chrome-ink": return mix(t.ink, t.chrome, .06);
      case "tool-ink": return mix(t.ink, t.chrome, .08);
      case "dim-ink": return mix(t.ink, t.chrome, .16);
      case "coords-ink": return t.ink;
      case "icon-ink": return mix(t.ink, t.panel, .14);
      case "soft": return toward(t.panel, .05);
      case "rule": return t._dark ? deeper(t.panel, .2) : toward(t.panel, .12);
      case "layer-on": return toward(t.chrome, .14);
      case "ls-bg": return deeper(t.chrome, .12);
      case "ink-bright": return mix(t.ink, t._dark ? "#ffffff" : black, .6);
      case "ink-strong": return mix(t.ink, t._dark ? "#ffffff" : black, .35);
      case "soft-ink": return mix(t.ink, t.panel, .08);
      case "caption-ink": return mix(t.ink, t.panel, .18);
      case "split-ink": return mix(t.ink, t.panel, .26);
      case "sel-sub-ink": return mix(t["selection-ink"], t.selection, .12);
      case "bad-ink": return t["error-ink"];
      case "km-warn": return t["warn-ink"];
      case "ok-line": return mix(t["ok-ink"], t.panel, .55);
      case "warn-line": return mix(t["warn-ink"], t.panel, .55);
      case "bad-line": return mix(t["error-ink"], t.panel, .55);
      case "conflict-line": return mix(t["warn-ink"], t.panel, .3);
      case "err-mark": return t["error-ink"];
      case "warn-mark": return t["warn-ink"];
      case "ok-mark": return t["ok-ink"];
      case "danger": return t["error-ink"];
      case "warning": return t["warn-ink"];
      case "info": return t["diff-changed"] || (t._dark ? "#75beff" : "#0b62b0");
      case "danger-fill": return t._dark ? "#c4281c" : "#b3261e";
      case "on-danger": return "#ffffff";
      case "bar-bg": return null;
      default: return null;
    }
  }

  function convert(input, opts = {}) {
    const c = C(), Th = T();
    let data = typeof input === "string" ? parseJSONC(input) : input;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("A VS Code theme is a JSON object.");
    const colors = {...(data.colors && typeof data.colors === "object" ? data.colors : {}),
      ...(data["workbench.colorCustomizations"] && typeof data["workbench.colorCustomizations"] === "object" ? data["workbench.colorCustomizations"] : {})};
    const tokenColors = Array.isArray(data.tokenColors) ? data.tokenColors : [];
    if (!Object.keys(colors).length && !tokenColors.length) throw Error("This file has no \"colors\" or \"tokenColors\"; it does not look like a VS Code colour theme.");
    const kind = kindOf(data, colors), preset = kind === "hc" ? "hc" : kind === "dark" ? "dark" : "light";
    const base = Th.tokensFor({...Th.DEFAULTS, preset, followSystem:false, accent:"", tokens:{}});
    const report = {name:String(data.name || data.label || "Imported theme").slice(0, 80), kind, preset, mapped:{}, derived:[], adjusted:[], warnings:[], unused:[]};
    if (typeof data.include === "string") report.warnings.push("This theme includes \"" + data.include + "\", which a pasted file can't load; open the .vsix to get the full theme.");
    const t = {_dark:kind === "dark" || kind === "hc"}, from = {}, used = new Set();
    const value = (keys, under) => {
      for (const k of keys) {
        const v = colors[k];
        if (!isColor(v)) continue;
        used.add(k);
        const a = c.rgba(v)[3];
        return {key:k, color:a < 1 && under ? c.over(v, under) : c.hex(v)};
      }
      return null;
    };
    for (const [token, keys, surface] of MAP) {
      if (token === "shadow-md") continue;
      const under = surface ? t[surface] || base[surface] : null;
      const hit = value(keys, under);
      if (hit) { t[token] = hit.color; from[token] = hit.key; report.mapped[token] = hit.key; }
      else { const d = derived(t, token); if (d) { t[token] = d; report.derived.push(token); } }
      if (token === "canvas-bg" && !t[token]) { t[token] = t._dark ? "#1e1e1e" : "#ffffff"; report.derived.push(token); }
      if (token === "accent" && !hit) t.accent = base.accent;
    }
    // Everything else: derived, or the base preset's value.
    for (const k of [...Th.TOKENS, ...Th.OPTIONAL]) {
      if (t[k]) continue;
      const d = derived(t, k);
      if (d) { t[k] = d; report.derived.push(k); } else if (base[k]) t[k] = base[k];
    }
    t["on-accent"] = t["on-accent-2"] = t["accent-btn-ink"] = c.bestInk(t.accent, "#141414", "#ffffff");
    t["bar-bg"] = c.hex(t["menu-bg"] || t.raised) + "f2";
    t.danger = t["error-ink"]; t.warning = t["warn-ink"];
    const shadow = colors["widget.shadow"];
    if (isColor(shadow)) { const h8 = c.rgba(shadow), hx = c.hex(shadow) + Math.round(h8[3] * 255).toString(16).padStart(2, "0"); t["shadow-sm"] = t["shadow-md"] = hx; t["shadow-lg"] = hx; used.add("widget.shadow"); }
    // Contrast: nudge what fails. Backgrounds first (they never move), then inks in TEXT order.
    for (const [fg, bg, min] of TEXT) {
      if (!t[fg] || !t[bg]) continue;
      const r = c.contrast(t[fg], t[bg]);
      if (r >= min - 1e-9) continue;
      const explicit = !!from[fg], fixed = legible(t[fg], t[bg], min), entry = {token:fg, on:bg, ratio:+r.toFixed(2), min, to:fixed, after:ratio(fixed, t[bg]), source:from[fg] || null};
      if (explicit) report.warnings.push((from[fg]) + " on " + (from[bg] || bg) + " is " + entry.ratio + ":1 (WCAG needs " + min + ":1)" + (opts.fix === false ? "." : "; raised to " + entry.after + ":1."));
      if (opts.fix !== false || !explicit) { t[fg] = fixed; report.adjusted.push(entry); }
      // Keep the dependent shades in step.
      if (fg === "accent") t["on-accent"] = t["on-accent-2"] = t["accent-btn-ink"] = c.bestInk(t.accent, "#141414", "#ffffff");
    }
    report.unused = Object.keys(colors).filter(k => !used.has(k));
    const tokens = {};
    const hex8 = v => { const a = c.rgba(v); return a ? c.hex(v) + (a[3] < 1 ? Math.round(a[3] * 255).toString(16).padStart(2, "0") : "") : null; };
    for (const k of [...Th.TOKENS, ...Th.OPTIONAL]) if (t[k]) { const v = /^#[0-9a-f]{3,8}$/i.test(t[k]) ? t[k].toLowerCase() : hex8(t[k]); if (v) tokens[k] = v; }
    // Only what differs from the base preset is stored.
    const settings = {preset, followSystem:false, accent:"", name:report.name, tokens:{}};
    for (const [k, v] of Object.entries(tokens)) if (String(base[k] || "").toLowerCase() !== v) settings.tokens[k] = v;
    const check = Th.validate({"atrium-theme":Th.FORMAT, ...settings});
    if (!check.ok) throw Error(check.errors.join(" "));
    report.contrast = TEXT.filter(([f, b]) => tokens[f] && tokens[b]).map(([f, b, min]) => ({token:f, on:b, ratio:ratio(tokens[f], tokens[b]), min}));
    const out = {settings, tokens, report};
    if (opts.canvas) out.canvas = canvasFrom(data, tokens, colors);
    return out;
  }

  // ------------------------------------------------------------------ syntax colours -> canvas
  const SCOPES = {
    keyword:["keyword", "storage.type", "storage.modifier", "keyword.control"], string:["string"], function:["entity.name.function", "support.function"],
    type:["entity.name.type", "support.type", "entity.name.class", "support.class"], number:["constant.numeric", "constant.language", "constant"],
    variable:["variable", "variable.parameter"], tag:["entity.name.tag"], attribute:["entity.other.attribute-name"], comment:["comment"]
  };
  function syntax(data, colors) {
    const out = {};
    for (const rule of Array.isArray(data.tokenColors) ? data.tokenColors : []) {
      const fg = rule?.settings?.foreground;
      if (!isColor(fg)) continue;
      const scopes = (Array.isArray(rule.scope) ? rule.scope : String(rule.scope || "").split(",")).map(x => String(x).trim()).filter(Boolean);
      for (const [name, list] of Object.entries(SCOPES)) if (!out[name] && scopes.some(s => list.some(l => s === l || s.startsWith(l + ".")))) out[name] = C().hex(fg);
    }
    // Themes without tokenColors: the terminal palette.
    for (const [name, key] of [["keyword", "terminal.ansiMagenta"], ["string", "terminal.ansiGreen"], ["function", "terminal.ansiYellow"], ["type", "terminal.ansiCyan"], ["number", "terminal.ansiRed"], ["variable", "terminal.ansiBlue"]])
      if (!out[name] && isColor(colors[key])) out[name] = C().hex(colors[key]);
    return out;
  }
  function canvasFrom(data, tokens, colors) {
    const c = C(), warnings = [], editorBg = tokens["canvas-bg"], ink = tokens.ink;
    const board = dark(editorBg) ? c.mix(editorBg, "#000000", .35) : c.mix(dark(ink) ? ink : "#202020", "#000000", .45);
    const workspace = dark(editorBg) ? editorBg : c.mix(board, "#ffffff", .2), selection = "#ffffff";
    const syn = syntax(data, colors);
    // Saturated, distinct candidates, legible on the board, darker than the selection white.
    const fit = col => {
      let x = c.ensureContrast(col, board, 3);
      for (let i = 0; i < 12 && c.contrast(x, selection) < 1.6; i++) x = c.mix(x, board, .08);
      return x;
    };
    const cands = [];
    for (const [name, col] of Object.entries(syn)) {
      if (name === "comment") continue;
      const [h, s] = hsl(col);
      if (s < .25) continue;
      if (cands.some(o => deltaE(o.color, col) < 12)) continue;
      cands.push({name, color:fit(col), hue:hsl(fit(col))[0]});
    }
    const closest = (target, pool) => pool.slice().sort((a, b) => hueGap(a.hue, target) - hueGap(b.hue, target))[0];
    const make = hue => fit(fromHsl(hue, .7, .58));
    let top = closest(10, cands) || {color:make(8), hue:8, name:"derived"};
    if (hueGap(top.hue, 10) > 70) top = {color:make(8), hue:8, name:"derived"};
    const rest = cands.filter(o => o !== top);
    let bottom = closest(220, rest);
    if (!bottom || hueGap(bottom.hue, top.hue) < 90 || hueGap(bottom.hue, 220) > 70) {
      const h = (top.hue + 200) % 360; bottom = {color:make(h), hue:h, name:"derived"};
    }
    const layers = {Top:top.color, Bottom:bottom.color};
    const yellow = closest(55, rest.filter(o => o !== bottom && hueGap(o.hue, 55) < 25));
    const inner = rest.filter(o => o !== bottom && o !== yellow && hueGap(o.hue, top.hue) >= 30 && hueGap(o.hue, bottom.hue) >= 30).sort((a, b) => a.hue - b.hue);
    for (let step = 1; inner.length < 6 && step < 24; step++) {
      const h = (top.hue + step * 47) % 360;
      if ([top, bottom, ...inner, ...(yellow ? [yellow] : [])].every(o => hueGap(o.hue, h) >= 25)) inner.push({color:make(h), hue:h, name:"derived"});
    }
    inner.slice(0, 6).forEach((o, i) => { layers["Inner " + (i + 1)] = o.color; });
    const silk = yellow ? yellow.color : fit(c.mix(ink, "#ffff00", dark(ink) ? .7 : .35));
    layers.Silk = silk; layers["Bottom silk"] = c.mix(silk, board, .45); layers.Multi = fit(c.mix(dark(ink) ? "#c0c0c0" : ink, board, .25));
    // EDA-critical pairs.
    const tb = deltaE(layers.Top, layers.Bottom);
    if (tb < 40) warnings.push("Top and bottom copper are close (ΔE " + tb.toFixed(0) + ").");
    const copper = Object.entries(layers).filter(([k]) => k === "Top" || k === "Bottom" || k.startsWith("Inner"));
    for (let i = 0; i < copper.length; i++) for (let j = i + 1; j < copper.length; j++) {
      const d = deltaE(copper[i][1], copper[j][1]);
      if (d < 15) warnings.push(copper[i][0] + " and " + copper[j][0] + " are hard to tell apart (ΔE " + d.toFixed(0) + ").");
    }
    for (const [k, v] of copper) if (c.contrast(v, selection) < 1.5) warnings.push(k + " is too close to the selection colour.");
    return {pcb:{colors:layers, system:{workspace, board}}, sch:{workspace:dark(editorBg) ? c.mix(editorBg, "#ffffff", .25) : c.mix(editorBg, "#000000", .3)},
      sources:{top:top.name, bottom:bottom.name}, checks:{topBottomDeltaE:+tb.toFixed(1)}, warnings};
  }

  // ------------------------------------------------------------------ apply
  function applyTheme(input, opts = {}) {
    const r = convert(input, opts), Th = T();
    if (r.canvas) r.settings.canvas = {follow:true, pcbBackground:r.canvas.pcb.system.workspace, schBackground:r.canvas.sch.workspace};
    Th.set(r.settings);
    if (r.canvas) {
      const V = globalThis.AtriumPCBAppearance;
      if (V) { for (const [l, col] of Object.entries(r.canvas.pcb.colors)) V.setColor(l, col); V.setSystem("board", r.canvas.pcb.system.board); }
      try { globalThis.AtriumNavHost?.redraw?.(); } catch {}
    }
    remember(r.report.name, input);
    return r;
  }
  // A Waffle theme document (atrium-theme v1, docs/themes.md) from a VS Code theme: every mapped and
  // derived token, the syntax colours and, with {canvas:true}, a copper layer set from them.
  const TYPE_OF = {dark:"dark", light:"light", hc:"hc-dark", hcLight:"hc-light"};
  function toDocument(input, opts = {}) {
    const data = typeof input === "string" ? parseJSONC(input) : input;
    const r = convert(data, opts), colors = {};
    for (const [k, v] of Object.entries(r.tokens)) if (/^#[0-9a-f]{3,8}$/.test(v)) colors[k] = v;
    const colorsIn = {...(data.colors || {}), ...(data["workbench.colorCustomizations"] || {})}, syn = syntax(data, colorsIn), out = {};
    for (const k of ["keyword", "string", "number", "comment", "function", "type", "variable"]) if (syn[k]) out[k] = syn[k];
    const doc = {"atrium-theme":1, name:String(opts.name || r.report.name).slice(0, 80), type:TYPE_OF[r.report.kind] || "dark",
      description:"Imported from a VS Code colour theme.", colors};
    if (Object.keys(out).length) doc.syntax = out;
    if (r.canvas) doc.canvas = {pcb:{system:{workspace:r.canvas.pcb.system.workspace, board:r.canvas.pcb.system.board}, layers:{...r.canvas.pcb.colors}}, sch:{workspace:r.canvas.sch.workspace}};
    return {doc, report:r.report, canvas:r.canvas};
  }
  // Save as one of the user's themes and use it (the theme library is loaded on demand).
  async function importAsTheme(input, opts = {}) {
    const L = globalThis.AtriumLazy, Lib = globalThis.AtriumThemes || (L ? await L.need("AtriumThemes") : null);
    if (!Lib) return applyTheme(input, opts);
    const r = toDocument(input, opts), id = Lib.saveUser(r.doc);
    Lib.select(id); remember(r.report.name, input);
    return {...r, id};
  }
  // Imported themes are listed in the dialog for switching back (names and source, 8 at most).
  const RECENT = "atrium.vscode-themes";
  function recent() { try { const v = JSON.parse(globalThis.localStorage?.getItem(RECENT) || "[]"); return Array.isArray(v) ? v.filter(x => x && typeof x.name === "string" && typeof x.json === "string") : []; } catch { return []; } }
  function remember(name, input) {
    if (EXAMPLES.some(e => e.name === name)) return;
    try {
      const json = typeof input === "string" ? input : JSON.stringify(input);
      if (json.length > 200000) return;
      const list = [{name, json}, ...recent().filter(x => x.name !== name)].slice(0, 8);
      globalThis.localStorage?.setItem(RECENT, JSON.stringify(list));
    } catch {}
  }

  // ------------------------------------------------------------------ .vsix (zip)
  // Caps against zip bombs: bytes per entry, bytes per import, themes and include depth.
  // Entry count and compression ratio as AtriumSexpr.unzip (sexpr.js).
  const VSIX = {entry: 8e6, total: 32e6, themes: 64, entries: 10000, ratio: 400};
  async function inflate(bytes, cap = VSIX.entry) {
    if (typeof DecompressionStream !== "function") throw Error("This build can't unpack compressed .vsix files; open the theme's .json instead.");
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(), parts = [];
    let n = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if ((n += value.length) > cap) { reader.cancel().catch(() => {}); throw Error("A file in this .vsix is larger than " + Math.round(cap / 1e6) + " MB."); }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const v of parts) { out.set(v, o); o += v.length; }
    return out;
  }
  function entries(buf) {
    const u = new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out = new Map();
    let eocd = -1;
    for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw Error("This is not a .vsix (zip) file.");
    let p = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true), dec = new TextDecoder();
    if (count > VSIX.entries) throw Error("This .vsix has too many files.");
    for (let n = 0; n < count && p + 46 <= u.length && dv.getUint32(p, true) === 0x02014b50; n++) {
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
      const name = dec.decode(u.subarray(p + 46, p + 46 + nameLen));
      if (local + 30 > u.length) throw Error("The .vsix is damaged.");
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      out.set(name, {method, usize, data:u.subarray(start, start + size)});
      p += 46 + nameLen + extra + comment;
    }
    return out;
  }
  async function readVsix(buf) {
    const files = entries(buf), dec = new TextDecoder(), cache = new Map();
    let total = 0;
    const text = async name => {
      if (cache.has(name)) return cache.get(name);
      const e = files.get(name);
      if (!e) throw Error("The .vsix has no " + name + ".");
      // The declared size is checked before inflating; inflation stops at the cap either way.
      const left = VSIX.total - total;
      if (e.usize > Math.min(VSIX.entry, left) || e.data.length > Math.min(VSIX.entry, left)) throw Error(name + " in this .vsix is too large.");
      if (e.usize > 1024 * 1024 && e.usize > e.data.length * VSIX.ratio) throw Error(name + " in this .vsix has a suspicious compression ratio.");
      let bytes;
      if (e.method === 0) bytes = e.data;
      else if (e.method === 8) bytes = await inflate(e.data, Math.min(VSIX.entry, left));
      else throw Error("Unsupported compression in " + name + ".");
      total += bytes.length;
      const t = dec.decode(bytes);
      cache.set(name, t);
      return t;
    };
    const pkg = parseJSONC(await text("extension/package.json"));
    const themes = pkg?.contributes?.themes;
    if (!Array.isArray(themes) || !themes.length) throw Error("This extension contributes no colour themes.");
    if (themes.length > VSIX.themes) throw Error("This extension lists " + themes.length + " themes; at most " + VSIX.themes + " are read.");
    const norm = path => { const parts = []; for (const s of path.split("/")) { if (s === "..") parts.pop(); else if (s && s !== ".") parts.push(s); } return parts.join("/"); };
    async function load(path, depth = 0) {
      const json = parseJSONC(await text(path));
      if (typeof json.include === "string" && depth < 4) {
        const parent = await load(norm(path.replace(/[^/]*$/, "") + json.include), depth + 1);
        const merged = {...parent, ...json, colors:{...(parent.colors || {}), ...(json.colors || {})}, tokenColors:[...(Array.isArray(parent.tokenColors) ? parent.tokenColors : []), ...(Array.isArray(json.tokenColors) ? json.tokenColors : [])]};
        delete merged.include; return merged;
      }
      return json;
    }
    const out = [];
    for (const th of themes) {
      try { const json = await load(norm("extension/" + th.path)); json.type ||= UI_THEME[th.uiTheme] || undefined; json.name ||= th.label; out.push({label:String(th.label || json.name || th.path), uiTheme:th.uiTheme || "", json}); }
      catch (e) { out.push({label:String(th.label || th.path), uiTheme:th.uiTheme || "", error:e.message}); }
    }
    return out;
  }

  // ------------------------------------------------------------------ keybindings
  // VS Code command -> Waffle command. Only commands with a real equivalent are listed.
  const COMMANDS = {
    "workbench.action.showCommands":"command-palette", "workbench.action.quickOpen":"goto-object", "workbench.action.showAllSymbols":"goto-object",
    "workbench.action.gotoSymbol":"goto-object", "workbench.action.gotoLine":"goto-location",
    "workbench.action.files.save":"save", "workbench.action.files.saveAll":"save", "workbench.action.files.openFile":"open", "workbench.action.files.openFileFolder":"open",
    "workbench.action.files.openFolder":"open", "workbench.action.files.newUntitledFile":"new", "workbench.action.newWindow":"new", "workbench.action.print":"print",
    "undo":"undo", "redo":"redo", "editor.action.clipboardCutAction":"cut", "editor.action.clipboardCopyAction":"copy", "editor.action.clipboardPasteAction":"paste",
    "editor.action.selectAll":"select-all", "editor.action.duplicateSelection":"duplicate", "editor.action.copyLinesDownAction":"duplicate", "deleteRight":"delete", "editor.action.deleteLines":"delete",
    "actions.find":"find", "workbench.action.findInFiles":"find", "editor.action.startFindReplaceAction":"find-replace", "workbench.action.replaceInFiles":"find-replace",
    "workbench.action.zoomIn":"zoom-in", "workbench.action.zoomOut":"zoom-out", "editor.action.fontZoomIn":"zoom-in", "editor.action.fontZoomOut":"zoom-out", "workbench.action.zoomReset":"fit",
    "workbench.action.toggleSidebarVisibility":"toggle-left", "workbench.action.toggleAuxiliaryBar":"toggle-right", "workbench.action.togglePanel":"messages", "workbench.actions.view.problems":"messages",
    "workbench.action.splitEditor":"split-right", "workbench.action.splitEditorRight":"split-right", "workbench.action.splitEditorDown":"split-down", "workbench.action.toggleEditorGroupLayout":"split-toggle",
    "workbench.action.closeEditorsInOtherGroups":"split-close", "workbench.action.openSettings":"preferences", "workbench.action.openGlobalKeybindings":"keyboard-shortcuts",
    "workbench.action.openGlobalKeybindingsFile":"keyboard-shortcuts", "workbench.action.selectTheme":"theme-preferences", "workbench.action.toggleLightDarkThemes":"theme-toggle",
    "workbench.action.keybindingsReference":"shortcuts", "workbench.action.showInteractivePlayground":"shortcuts", "editor.action.marker.next":"messages", "workbench.action.closeActiveEditor":"split-close",
    "editor.action.rename":"tool-properties", "editor.action.showHover":"context-menu", "editor.action.showContextMenu":"context-menu"
  };
  const KEYS = {escape:"Escape", esc:"Escape", enter:"Enter", tab:"Tab", space:"Space", backspace:"Backspace", delete:"Delete", insert:"Insert", home:"Home", end:"End",
    pageup:"PageUp", pagedown:"PageDown", up:"Up", down:"Down", left:"Left", right:"Right", numpad_add:"+", numpad_subtract:"-", numpad_multiply:"*", numpad_divide:"/",
    oem_plus:"=", oem_minus:"-", oem_comma:",", oem_period:".", oem_1:";", oem_2:"/", oem_3:"`", oem_4:"[", oem_5:"\\", oem_6:"]", oem_7:"'", contextmenu:"ContextMenu"};
  function keyText(vs, mac) {
    const chords = String(vs || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!chords.length || chords.length > 3) throw Error("unsupported key \"" + vs + "\"");
    return chords.map(ch => {
      const parts = ch.length > 1 && ch.endsWith("++") ? [...ch.slice(0, -2).split("+").filter(Boolean), "+"] : ch.split("+");
      const k = parts.pop(), mods = [];
      for (const m of parts) {
        if (m === "cmd" || m === "meta" && mac || m === "win" && mac) mods.push("Mod");
        else if (m === "ctrl") mods.push(mac ? "Ctrl" : "Mod");
        else if (m === "shift") mods.push("Shift");
        else if (m === "alt" || m === "option") mods.push("Alt");
        else if (m === "meta" || m === "win") mods.push("Meta");
        else throw Error("unknown modifier \"" + m + "\"");
      }
      let name = KEYS[k] || (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : /^[a-z]$/.test(k) ? k.toUpperCase() : /^\d$/.test(k) || /^[-=[\];',./\\`]$/.test(k) ? k : /^numpad\d$/.test(k) ? k.slice(6) : null);
      if (!name) throw Error("unknown key \"" + k + "\"");
      return [...new Set(mods), name].join("+");
    }).join(" ");
  }
  const STATES = [{kind:"schematic", tool:"select", canvas:true, selected:true, selectionCount:1}, {kind:"pcb", tool:"select", canvas:true, selected:true, selectionCount:1}];
  function planKeybindings(text) {
    const K = globalThis.AtriumKeymap;
    if (!K) throw Error("The key map is not loaded.");
    let list = typeof text === "string" ? parseJSONC(text) : text;
    if (!Array.isArray(list)) throw Error("A VS Code keybindings.json is a list of {key, command} entries.");
    const mac = list.some(e => /(^|[\s+])cmd\+/i.test(String(e?.key || "")));
    const rows = [];
    for (const e of list) {
      if (!e || typeof e !== "object" || typeof e.command !== "string") { rows.push({status:"invalid", vscode:String(e?.command || ""), key:String(e?.key || ""), detail:"Not a {key, command} entry."}); continue; }
      const remove = e.command.startsWith("-"), name = remove ? e.command.slice(1) : e.command, id = COMMANDS[name];
      const row = {vscode:e.command, key:String(e.key || ""), command:id || "", remove, when:e.when ? String(e.when) : ""};
      if (!id || !K.command(id)) { rows.push({...row, status:"unmapped", detail:"No Waffle equivalent."}); continue; }
      try { row.atrium = K.normalize(keyText(e.key, mac)); }
      catch (err) { rows.push({...row, status:"invalid", detail:err.message}); continue; }
      row.title = K.command(id).title;
      if (remove) { rows.push({...row, status:"remove", detail:"Removes " + K.display(row.atrium) + " from " + row.title + " if bound."}); continue; }
      if (K.bindingsFor(id).some(b => b.key === row.atrium)) { rows.push({...row, status:"same", detail:""}); continue; }
      const clash = new Set();
      for (const s of STATES) { let hit = null; try { hit = K.resolve(row.atrium, s); } catch {} if (hit && hit !== id) clash.add(hit === "prefix" ? "a longer key sequence" : K.command(hit)?.title || hit); }
      rows.push({...row, status:clash.size ? "conflict" : "ok", detail:clash.size ? "Also runs " + [...clash].join(", ") + "." : row.when ? "VS Code's when clause is ignored." : ""});
    }
    // The same key imported for two commands is a conflict too.
    const seen = new Map();
    for (const r of rows) if (r.status === "ok" || r.status === "conflict") {
      const o = seen.get(r.atrium);
      if (o && o.command !== r.command) { r.status = "conflict"; r.detail = (r.detail ? r.detail + " " : "") + "Imported for " + o.title + " too."; }
      else seen.set(r.atrium, r);
    }
    return {rows, mac};
  }
  function applyKeybindings(plan, {skipConflicts = false} = {}) {
    const K = globalThis.AtriumKeymap, applied = [], skipped = [];
    for (const r of plan.rows) {
      if (r.status === "remove") {
        const list = K.bindingsFor(r.command), keep = list.filter(b => b.key !== r.atrium);
        if (keep.length !== list.length) { K.setBindings(r.command, keep.map(b => ({key:b.key, when:b.when}))); applied.push(r); }
        continue;
      }
      if (r.status === "ok" || r.status === "conflict" && !skipConflicts) { K.addBinding(r.command, r.atrium, ""); applied.push(r); }
      else if (r.status !== "same") skipped.push(r);
    }
    const ids = new Set(applied.map(r => r.command));
    const conflicts = K.conflicts().filter(x => x.type === "conflict" && (ids.has(x.a.command) || ids.has(x.b.command)));
    return {applied, skipped, conflicts};
  }

  // ------------------------------------------------------------------ examples
  // Original themes written for Waffle in VS Code's colour-theme format (with comments and
  // trailing commas, as VS Code allows), one each of dark, light and high contrast.
  const EXAMPLES = [
    {name:"Ember Night", json:`{
  // A warm charcoal dark theme with an ember accent.
  "name": "Ember Night",
  "type": "dark",
  "colors": {
    "editor.background": "#1b1a19",
    "editor.foreground": "#e6dfd6",
    "foreground": "#ddd5ca",
    "descriptionForeground": "#b0a698",
    "disabledForeground": "#9a9184",
    "focusBorder": "#ff8a3d",
    "sideBar.background": "#232120",
    "sideBar.foreground": "#ddd5ca",
    "sideBar.border": "#141312",
    "sideBarSectionHeader.background": "#2c2a28",
    "sideBarSectionHeader.foreground": "#f1e9de",
    "activityBar.background": "#171615",
    "activityBar.foreground": "#ece4d9",
    "activityBar.inactiveForeground": "#a0968a",
    "activityBar.activeBorder": "#ff8a3d",
    "titleBar.activeBackground": "#1f1d1c",
    "titleBar.activeForeground": "#e2dacf",
    "statusBar.background": "#1f1d1c",
    "statusBar.foreground": "#cfc6ba",
    "editorGroupHeader.tabsBackground": "#181716",
    "tab.inactiveBackground": "#1d1c1b",
    "tab.activeBackground": "#2c2a28",
    "tab.inactiveForeground": "#a89e91",
    "tab.activeForeground": "#fff6ea",
    "tab.activeBorderTop": "#ff8a3d",
    "tab.hoverBackground": "#262422",
    "list.hoverBackground": "#ffffff0f",
    "list.activeSelectionBackground": "#5a3a24",
    "list.activeSelectionForeground": "#fff3e6",
    "list.inactiveSelectionBackground": "#3a3029",
    "button.background": "#b04c16",
    "button.foreground": "#ffffff",
    "button.secondaryBackground": "#34312e",
    "button.secondaryHoverBackground": "#3e3a36",
    "input.background": "#141312",
    "input.border": "#3f3a35",
    "dropdown.background": "#2a2725",
    "menu.background": "#262422",
    "menu.foreground": "#e6dfd6",
    "editorWidget.background": "#2a2725",
    "editorWidget.border": "#4a433c",
    "panel.border": "#3a3632",
    "widget.shadow": "#00000080",
    "errorForeground": "#ff7b6b",
    "editorError.foreground": "#ff6b5b",
    "editorWarning.foreground": "#e8b24a",
    "gitDecoration.modifiedResourceForeground": "#e2b66c",
    "gitDecoration.addedResourceForeground": "#9ccf7a",
    "gitDecoration.deletedResourceForeground": "#ef8a7a",
    "terminal.ansiGreen": "#9ccf7a",
  },
  "tokenColors": [
    { "scope": ["comment"], "settings": { "foreground": "#7d7368", "fontStyle": "italic" } },
    { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#ff8a5c" } },
    { "scope": "string", "settings": { "foreground": "#c2d97a" } },
    { "scope": ["entity.name.function", "support.function"], "settings": { "foreground": "#f2c36b" } },
    { "scope": ["entity.name.type", "support.type"], "settings": { "foreground": "#7cc4e0" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#d79be8" } },
    { "scope": "variable", "settings": { "foreground": "#e6dfd6" } },
    { "scope": "entity.name.tag", "settings": { "foreground": "#6fd1b0" } },
  ],
}`},
    {name:"Paper Studio", json:`{
  /* A soft light theme: warm paper, ink-blue text and a teal accent. */
  "name": "Paper Studio",
  "type": "light",
  "colors": {
    "editor.background": "#fbf8f2",
    "editor.foreground": "#2b2f36",
    "foreground": "#2e323a",
    "descriptionForeground": "#5b606b",
    "focusBorder": "#0f7f7a",
    "sideBar.background": "#f3efe6",
    "sideBar.border": "#ddd6c8",
    "sideBarSectionHeader.background": "#ebe5d9",
    "sideBarSectionHeader.foreground": "#22262d",
    "activityBar.background": "#e9e3d6",
    "activityBar.foreground": "#2b2f36",
    "activityBar.inactiveForeground": "#5f5c55",
    "activityBar.activeBorder": "#0b706b",
    "titleBar.activeBackground": "#ece6da",
    "titleBar.activeForeground": "#2b2f36",
    "statusBar.background": "#0f7f7a",
    "statusBar.foreground": "#ffffff",
    "editorGroupHeader.tabsBackground": "#e6dfd1",
    "tab.inactiveBackground": "#ece6da",
    "tab.activeBackground": "#fbf8f2",
    "tab.inactiveForeground": "#5e5b55",
    "tab.activeForeground": "#1d2026",
    "tab.activeBorderTop": "#0f7f7a",
    "list.hoverBackground": "#0000000a",
    "list.activeSelectionBackground": "#cfe6e2",
    "list.activeSelectionForeground": "#14211f",
    "button.background": "#0f7f7a",
    "button.foreground": "#ffffff",
    "button.secondaryBackground": "#e3ddd0",
    "input.background": "#ffffff",
    "input.border": "#cfc7b8",
    "menu.background": "#fffdf8",
    "editorWidget.background": "#f6f2ea",
    "editorWidget.border": "#d6cfc1",
    "panel.border": "#ddd6c8",
    "widget.shadow": "#3b302033",
    "errorForeground": "#b3261e",
    "editorWarning.foreground": "#855600",
    "gitDecoration.modifiedResourceForeground": "#8a5a00",
    "gitDecoration.addedResourceForeground": "#2f7a3a",
    "gitDecoration.deletedResourceForeground": "#a43a2a",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#8a877f" } },
    { "scope": "keyword", "settings": { "foreground": "#b2462e" } },
    { "scope": "string", "settings": { "foreground": "#4f7d23" } },
    { "scope": "entity.name.function", "settings": { "foreground": "#8a5a00" } },
    { "scope": "entity.name.type", "settings": { "foreground": "#2a5fa8" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#8e3fa0" } },
    { "scope": "entity.name.tag", "settings": { "foreground": "#0f7f7a" } },
  ],
}`},
    {name:"Signal Contrast", json:`{
  // High contrast: black surfaces, white text, bright borders and a signal-yellow accent.
  "name": "Signal Contrast",
  "type": "hc",
  "colors": {
    "editor.background": "#000000",
    "editor.foreground": "#ffffff",
    "foreground": "#ffffff",
    "contrastBorder": "#6fc3df",
    "contrastActiveBorder": "#ffd400",
    "focusBorder": "#ffd400",
    "sideBar.background": "#000000",
    "activityBar.background": "#000000",
    "activityBar.activeBorder": "#ffd400",
    "titleBar.activeBackground": "#000000",
    "titleBar.activeForeground": "#ffffff",
    "tab.inactiveBackground": "#000000",
    "tab.activeBackground": "#0a0a0a",
    "tab.inactiveForeground": "#ffffff",
    "tab.activeBorderTop": "#ffd400",
    "list.hoverBackground": "#ffffff1f",
    "list.activeSelectionBackground": "#003a52",
    "list.activeSelectionForeground": "#ffffff",
    "button.background": "#0b5a7a",
    "button.foreground": "#ffffff",
    "button.border": "#6fc3df",
    "input.background": "#000000",
    "input.border": "#6fc3df",
    "menu.background": "#000000",
    "errorForeground": "#ff8a80",
    "editorWarning.foreground": "#ffd400",
    "gitDecoration.addedResourceForeground": "#7ee787",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#9fe39a" } },
    { "scope": "keyword", "settings": { "foreground": "#ff7a5c" } },
    { "scope": "string", "settings": { "foreground": "#ffd27a" } },
    { "scope": "entity.name.function", "settings": { "foreground": "#fff06a" } },
    { "scope": "entity.name.type", "settings": { "foreground": "#5cc8ff" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#c792ff" } },
    { "scope": "entity.name.tag", "settings": { "foreground": "#5cffd0" } },
  ],
}`}
  ];

  // ------------------------------------------------------------------ dialogs
  const doc = globalThis.document;
  const el = (tag, cls, text) => AtriumNavCommon.classedElement(doc, tag, cls, text);
  const btn = (text, fn, cls) => { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; return b; };
  function style() {
    if (doc.getElementById("vsc-style")) return;
    const s = el("style"); s.id = "vsc-style";
    s.textContent = ".vsc-dialog{width:min(760px,calc(100vw - 32px));max-height:min(720px,90vh);padding:0;color:var(--ink);background:var(--panel);border:1px solid var(--line-strong);display:flex;flex-direction:column}" +
      ".vsc-dialog:not([open]){display:none}.vsc-dialog h2{margin:0;padding:10px 14px;font-size:14px;background:var(--panel-head);border-bottom:1px solid var(--line)}" +
      ".vsc-body{padding:10px 14px;overflow:auto;display:flex;flex-direction:column;gap:8px}.vsc-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}" +
      ".vsc-dialog textarea{width:100%;box-sizing:border-box;min-height:120px;font:12px var(--mono,monospace);color:var(--ink);background:var(--field);border:1px solid var(--input-line)}" +
      ".vsc-swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:4px}.vsc-sw{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}" +
      ".vsc-sw i{flex:none;width:18px;height:18px;border:1px solid var(--swatch-line,#8888)}.vsc-report{margin:0;padding-left:18px;font-size:12px;max-height:150px;overflow:auto}" +
      ".vsc-warn{color:var(--warn-ink)}.vsc-table{width:100%;border-collapse:collapse;font-size:12px}.vsc-table td,.vsc-table th{padding:2px 6px;border-bottom:1px solid var(--line);text-align:left}" +
      ".vsc-dialog .vsc-status{margin:0;padding:6px 14px;font-size:12px;color:var(--muted);min-height:16px}.vsc-dialog .work-actions{margin:0;padding:8px 14px;border-top:1px solid var(--line);display:flex;gap:6px;justify-content:flex-end}" +
      // No dead band under the checkbox: empty preview blocks and an empty status take no space.
      ".vsc-body>.vsc-swatches:empty,.vsc-body>.vsc-report:empty{display:none}.vsc-dialog .vsc-status:empty{padding:0;min-height:0}" +
      ".vsc-pick[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 0 -2px 0 var(--accent)}";
    doc.head.append(s);
  }
  function shell(title) {
    style();
    const d = el("dialog", "work-dialog vsc-dialog"), h = el("h2", null, title), body = el("div", "vsc-body"), st = el("p", "vsc-status"), actions = el("div", "work-actions");
    st.setAttribute("role", "status"); d.setAttribute("aria-label", title);
    d.append(h, body, st, actions);
    d.addEventListener("close", () => d.remove());
    doc.body.append(d);
    return {d, title:h, body, actions, status:(t, bad) => { st.textContent = t || ""; st.classList.toggle("vsc-warn", !!bad); }};
  }
  function fileInput(accept, onText) {
    const f = el("input"); f.type = "file"; f.accept = accept; f.hidden = true;
    f.onchange = () => { const x = f.files?.[0]; f.value = ""; if (x) onText(x); };
    return f;
  }
  function themeDialog(start) {
    if (!doc?.body) return null;
    const ui = shell("Import VS Code colour theme"), Th = T();
    const before = Th.get();
    const intro = el("p", null, "Paste a VS Code colour theme (JSON with comments is fine), open a .json or .vsix, or start from an example. Workbench colours map onto Waffle; text is checked for WCAG contrast.");
    intro.style.margin = "0";
    const picks = el("div", "vsc-row");
    const area = el("textarea", "ui-field"); area.setAttribute("aria-label", "VS Code theme JSON"); area.spellcheck = false;
    const vsixPick = el("select"); vsixPick.hidden = true; vsixPick.setAttribute("aria-label", "Theme in this extension");
    let vsix = [];
    const file = fileInput(".json,.jsonc,.vsix,application/json", async f => {
      try {
        if (/\.vsix$/i.test(f.name)) {
          vsix = (await readVsix(await f.arrayBuffer())).filter(x => x.json);
          if (!vsix.length) throw Error("No theme in this extension could be read.");
          vsixPick.replaceChildren(...vsix.map((x, i) => { const o = el("option", null, x.label); o.value = String(i); return o; }));
          vsixPick.hidden = vsix.length < 2; area.value = JSON.stringify(vsix[0].json, null, 2);
        } else { vsix = []; vsixPick.hidden = true; area.value = await f.text(); }
        mark(null); preview();
      } catch (e) { ui.status(e.message, true); }
    });
    vsixPick.onchange = () => { area.value = JSON.stringify(vsix[+vsixPick.value].json, null, 2); preview(); };
    const exampleButtons = EXAMPLES.map(x => { const b = btn(x.name, () => { area.value = x.json; mark(b); preview(); }, "vsc-pick"); b.setAttribute("aria-pressed", "false"); b.title = "Built-in example (" + /"type":\s*"(\w+)"/.exec(x.json)[1] + ")"; return b; });
    const mark = b => exampleButtons.forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    picks.append(el("span", null, "Examples:"), ...exampleButtons);
    for (const r of recent().slice(0, 4)) picks.append(btn(r.name, () => { area.value = r.json; mark(null); preview(); }));
    picks.append(btn("Open file…", () => file.click()), file, vsixPick);
    const canvasRow = el("label", "vsc-row"), canvasBox = el("input", "ui-checkbox"); canvasBox.type = "checkbox";
    canvasRow.append(canvasBox, el("span", null, "Also recolour the canvas from the syntax colours (PCB layers, board and workspace backgrounds)"));
    canvasBox.onchange = () => preview();
    const swatches = el("div", "vsc-swatches"), layers = el("div", "vsc-swatches"), list = el("ul", "vsc-report");
    ui.body.append(intro, picks, area, canvasRow, swatches, layers, list);
    let current = null, timer = 0;
    area.addEventListener("input", () => { mark(null); clearTimeout(timer); timer = setTimeout(preview, 250); });
    function sw(parent, label, color) { const s = el("span", "vsc-sw"); const i = el("i"); i.style.setProperty("--swatch", color); s.append(i, el("span", null, label)); s.title = label + " " + color; parent.append(s); }
    function preview() {
      swatches.replaceChildren(); layers.replaceChildren(); list.replaceChildren(); current = null;
      if (!area.value.trim()) { ui.status(""); return; }
      try {
        const r = convert(area.value, {canvas:canvasBox.checked}); current = r;
        for (const k of ["app", "chrome", "panel", "panel-head", "field", "ink", "muted", "accent", "selection", "primary", "focus", "line"]) sw(swatches, k, r.tokens[k]);
        if (r.canvas) for (const [k, v] of Object.entries({...r.canvas.pcb.colors, board:r.canvas.pcb.system.board, workspace:r.canvas.pcb.system.workspace})) sw(layers, k, v);
        const rep = r.report, lines = [];
        lines.push([rep.name + ": " + rep.kind + " theme on Waffle's " + Th.PRESETS[rep.preset].label + " base; " + Object.keys(rep.mapped).length + " colours mapped, " + rep.derived.length + " derived, " + rep.adjusted.length + " adjusted for contrast.", false]);
        for (const w of rep.warnings) lines.push([w, true]);
        for (const w of r.canvas?.warnings || []) lines.push(["Canvas: " + w, true]);
        const worst = rep.contrast.reduce((m, x) => x.ratio / x.min < m.ratio / m.min ? x : m, {ratio:99, min:1});
        if (worst.token) lines.push(["Lowest text contrast: " + worst.token + " on " + worst.on + " " + worst.ratio + ":1 (needs " + worst.min + ":1).", worst.ratio < worst.min]);
        if (rep.unused.length) lines.push([rep.unused.length + " VS Code colours have no Waffle counterpart (editor syntax, terminal, minimap…).", false]);
        for (const [t, bad] of lines) { const li = el("li", bad ? "vsc-warn" : null, t); list.append(li); }
        ui.status(rep.warnings.length ? rep.warnings.length + " contrast warning" + (rep.warnings.length === 1 ? "" : "s") + "; the colours were adjusted." : "Ready to apply.");
      } catch (e) { ui.status(e.message, true); }
    }
    ui.actions.append(btn("Apply", () => {
      if (!current) { preview(); if (!current) return; }
      importAsTheme(area.value, {canvas:canvasBox.checked}).then(r => ui.status("Saved and applied " + r.report.name + " as one of your themes (View › Theme › Color Theme… lists it; Customize Theme… edits it)."),
        e => ui.status(e.message, true));
    }), btn("Undo", () => { try { Th.set(before); ui.status("Restored the previous appearance."); } catch (e) { ui.status(e.message, true); } }), btn("Close", () => ui.d.close()));
    const apply = ui.actions.querySelector("button");
    apply.dataset.variant = "primary"; apply.dataset.uiDefault = "false";
    ui.actions.append(apply);
    AtriumShell.adoptDialog(ui.d, {title:ui.title, body:ui.body, actions:ui.actions, initialFocus:area});
    if (start) { area.value = start; preview(); }
    ui.d.showModal?.();
    return ui.d;
  }
  function keysDialog(start) {
    if (!doc?.body) return null;
    const ui = shell("Import VS Code keybindings");
    const intro = el("p", null, "Paste your keybindings.json (Preferences: Open Keyboard Shortcuts (JSON) in VS Code) or open the file. Commands with a Waffle equivalent are added; nothing changes until you apply.");
    intro.style.margin = "0";
    const area = el("textarea", "ui-field"); area.setAttribute("aria-label", "VS Code keybindings JSON"); area.spellcheck = false;
    area.placeholder = '[\n  { "key": "ctrl+shift+p", "command": "workbench.action.showCommands" },\n  { "key": "ctrl+s", "command": "workbench.action.files.save" }\n]';
    const file = fileInput(".json,.jsonc,application/json", f => f.text().then(t => { area.value = t; preview(); }));
    const skipRow = el("label", "vsc-row"), skip = el("input", "ui-checkbox"); skip.type = "checkbox"; skip.checked = true;
    skipRow.append(skip, el("span", null, "Skip bindings that conflict with an existing Waffle key"));
    const table = el("table", "vsc-table");
    ui.body.append(intro, el("div", "vsc-row"), area, skipRow, table);
    ui.body.children[1].append(btn("Open file…", () => file.click()), file);
    let plan = null, timer = 0;
    area.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(preview, 250); });
    const LABEL = {ok:"Add", conflict:"Conflict", same:"Already set", remove:"Remove", unmapped:"No equivalent", invalid:"Invalid"};
    function preview() {
      table.replaceChildren(); plan = null;
      if (!area.value.trim()) { ui.status(""); return; }
      try {
        plan = planKeybindings(area.value);
        const head = el("tr"); for (const h of ["VS Code command", "Key", "Waffle command", "Result"]) head.append(el("th", null, h)); table.append(head);
        for (const r of plan.rows) {
          const tr = el("tr", r.status === "conflict" || r.status === "invalid" ? "vsc-warn" : null);
          const key = el("td", null, r.atrium ? null : r.key);
          if (r.atrium) key.append(AtriumShortcut.render(r.atrium, {variant:"inline"}));
          tr.append(el("td", null, r.vscode), key, el("td", null, r.title || "—"), el("td", null, LABEL[r.status] + (r.detail ? " · " + r.detail : "")));
          table.append(tr);
        }
        const n = s => plan.rows.filter(r => r.status === s).length;
        ui.status(n("ok") + " to add, " + n("conflict") + " conflicting, " + n("remove") + " removals, " + n("unmapped") + " without a Waffle equivalent" + (plan.mac ? " (macOS file: Cmd is Mod)." : " (Ctrl is Mod: ⌘ on a Mac)."), n("conflict") > 0);
      } catch (e) { ui.status(e.message, true); }
    }
    ui.actions.append(btn("Apply", () => {
      if (!plan) { preview(); if (!plan) return; }
      try {
        const r = applyKeybindings(plan, {skipConflicts:skip.checked});
        ui.status(r.applied.length + " applied, " + r.skipped.length + " skipped" + (r.conflicts.length ? "; " + r.conflicts.length + " conflict" + (r.conflicts.length === 1 ? "" : "s") + " remain: " + r.conflicts.map(c => c.message).slice(0, 3).join(" ") : ".") + " Keyboard shortcuts… can undo any of them.", r.conflicts.length > 0);
        plan = null;
      } catch (e) { ui.status(e.message, true); }
    }), btn("Close", () => ui.d.close()));
    const apply = ui.actions.querySelector("button");
    apply.dataset.variant = "primary"; apply.dataset.uiDefault = "false";
    ui.actions.append(apply);
    AtriumShell.adoptDialog(ui.d, {title:ui.title, body:ui.body, actions:ui.actions, initialFocus:area});
    if (start) { area.value = start; preview(); }
    ui.d.showModal?.();
    return ui.d;
  }

  return Object.freeze({parseJSONC, stripJSONC, convert, applyTheme, toDocument, importAsTheme, canvasFrom, syntax, readVsix, keyText, planKeybindings, applyKeybindings,
    COMMANDS, EXAMPLES, TEXT, recent, themeDialog, keysDialog, deltaE});
})();
