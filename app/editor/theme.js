"use strict";

// Appearance: colour theme, accent, UI density, UI font size, motion and the canvas
// palettes. The theme is a data-theme attribute plus a few custom properties on
// <html>; theme.css holds the token blocks. Load this file in <head>, after the
// stylesheets, so the saved theme is applied before the first paint. Every DOM access
// is guarded: headless hosts (JavaScriptCore, no document) get the pure functions.
globalThis.AtriumTheme = (() => {
  const STORE = "atrium.theme", FORMAT = 1;
  const doc = globalThis.document;
  const root = doc?.documentElement || null;
  const dom = !!(root && typeof doc.createElement === "function");

  // ------------------------------------------------------------------ presets
  // Token names as in style.css (without the leading dashes). `dark` repeats the
  // :root values exactly; tests/theme.cjs checks both files agree.
  const TOKENS = Object.freeze([
    "app","chrome","panel","panel-head","raised","hover","field","ink","muted","faint","line","line-strong","soft",
    "accent","selection","selection-ink","focus","primary","divider",
    "menu-bg","tab-bg","tab-hover","canvas-bg","bar-bg","bar-line","pressed","layer-on","ls-bg","ls-ink",
    "button","button-line","button-hover","input-line","rule","primary-line","sheet",
    "ink-bright","ink-strong","head-ink","tab-hover-ink","coords-ink","chrome-ink","tool-ink","soft-ink","icon-ink",
    "dim-ink","caption-ink","tab-ink","split-ink","on-accent","on-accent-2","on-primary","accent-btn-ink",
    "icon-folder","icon-sch","icon-pcb","error-ink","diff-changed","diff-added","diff-removed","ok-ink","ok-line",
    "warn-line","bad-ink","bad-line","err-mark","warn-mark","ok-mark","warn-ink","sel-sub-ink","badge-line","conflict-line","km-warn",
    "shadow-sm","shadow-md","shadow-lg","backdrop","shadow-drawer","swatch-edge","preview-edge","shadow-side",
    "shadow-vc","swatch-line",
    // Semantic status colours (docs/design-system.md): text-safe on panels (WCAG AA), and
    // a solid destructive fill with its ink.
    "danger","warning","info","danger-fill","on-danger"
  ]);
  // Formerly optional tokens (danger, warning) are now in TOKENS; kept for API stability.
  const OPTIONAL = Object.freeze([]);
  // Severity colours scoped to the Messages panel and Error Reporting options.
  const SCOPED = Object.freeze(["msg-fatal","msg-error","erc-none","erc-warning","erc-error","erc-fatal"]);
  const SCOPE_SELECTOR = ".msg-panel,.erc-options";

  const DARK = {
    app:"#1d1d1d",chrome:"#2b2b2b",panel:"#303030","panel-head":"#3b3b3b",raised:"#464646",hover:"#3d3d3d",field:"#222",
    ink:"#e2e2e2",muted:"#b9b9b9",faint:"#a9a9a9",line:"#474747","line-strong":"#5a5a5a",soft:"#393939",
    accent:"#0a84ff",selection:"#205387","selection-ink":"#fff",focus:"#45a2ff",primary:"#0974e0",divider:"var(--app)",
    "menu-bg":"#2d2d2d","tab-bg":"#2a2a2a","tab-hover":"#333","canvas-bg":"#000","bar-bg":"rgba(45,45,45,.94)",
    "bar-line":"#585858",pressed:"#4d4d4d","layer-on":"#4a4a4a","ls-bg":"#232323","ls-ink":"#ff6b5e",
    button:"#3c3c3c","button-line":"#989898","button-hover":"#4a4a4a","input-line":"#929292",rule:"#262626",
    "primary-line":"#45a2ff",sheet:"#fffcf8",
    "ink-bright":"#fff","ink-strong":"#f0f0f0","head-ink":"#ececec","tab-hover-ink":"#e8e8e8","coords-ink":"#e6e6e6",
    "chrome-ink":"#d6d6d6","tool-ink":"#d2d2d2","soft-ink":"#d0d0d0","icon-ink":"#c8c8c8","dim-ink":"#c4c4c4",
    "caption-ink":"#bdbdbd","tab-ink":"#b9b9b9","split-ink":"#a9a9a9","on-accent":"#141414","on-accent-2":"#141414",
    "on-primary":"#ffffff","accent-btn-ink":"#141414",
    "icon-folder":"#aab7c7","icon-sch":"#a6c8ff","icon-pcb":"#6fc27a","error-ink":"#f08a6a",
    "diff-changed":"#8fb3d9","diff-added":"#7fd18f","diff-removed":"#e8956e","ok-ink":"#9fe0b0","ok-line":"#3d6b4a",
    "warn-line":"#7a5a25","bad-ink":"#e8956e","bad-line":"#7a4a35",
    "err-mark":"#e06c75","warn-mark":"#d7a54a","ok-mark":"#57b06f","warn-ink":"#f0c46a","sel-sub-ink":"#e6eefc","badge-line":"#ffffff66","conflict-line":"#c9822a","km-warn":"#e0a040",
    "shadow-sm":"#0007","shadow-md":"#0009","shadow-lg":"#000b",backdrop:"#0008","shadow-drawer":"#000a",
    "swatch-edge":"#0006","preview-edge":"#0005","shadow-side":"#0004","shadow-vc":"rgba(0,0,0,.5)",
    "swatch-line":"rgba(255,255,255,.28)",
    danger:"#f0706a",warning:"#f0c46a",info:"#75beff","danger-fill":"#c4281c","on-danger":"#ffffff"
  };
  // A light UI after VS Code's Light+: white fields, pale grey chrome, dark ink.
  const LIGHT = {
    app:"#e6e6e6",chrome:"#efefef",panel:"#f8f8f8","panel-head":"#ececec",raised:"#dadada",hover:"#e8e8e8",field:"#ffffff",
    ink:"#1f1f1f",muted:"#505050",faint:"#606060",line:"#d6d6d6","line-strong":"#b5b5b5",soft:"#eeeeee",
    accent:"#1559a7",selection:"#cce0f7","selection-ink":"#0b0b0b",focus:"#0a6ed1",primary:"#0f6cbd",divider:"#d9d9d9",
    "menu-bg":"#ffffff","tab-bg":"#dddddd","tab-hover":"#d3d3d3","canvas-bg":"#1e1e1e","bar-bg":"#fafafaf5",
    "bar-line":"#c4c4c4",pressed:"#d8dde4","layer-on":"#ffffff","ls-bg":"#e2e2e2","ls-ink":"#b3261e",
    button:"#f3f3f3","button-line":"#797979","button-hover":"#e4e4e4","input-line":"#787878",rule:"#dcdcdc",
    "primary-line":"#0d5ea6",sheet:"#fffcf8",
    "ink-bright":"#000000","ink-strong":"#111111","head-ink":"#1a1a1a","tab-hover-ink":"#1f1f1f","coords-ink":"#1f1f1f",
    "chrome-ink":"#2b2b2b","tool-ink":"#333333","soft-ink":"#3b3b3b","icon-ink":"#424242","dim-ink":"#454545",
    "caption-ink":"#4a4a4a","tab-ink":"#4d4d4d","split-ink":"#555555","on-accent":"#ffffff","on-accent-2":"#ffffff",
    "on-primary":"#ffffff","accent-btn-ink":"#ffffff",
    "icon-folder":"#4e6074","icon-sch":"#2f5f99","icon-pcb":"#2e8540","error-ink":"#b42318",
    "diff-changed":"#1f5fa8","diff-added":"#1a7f37","diff-removed":"#b0461d","ok-ink":"#17772f","ok-line":"#8cc79a",
    "warn-line":"#d9a75a","bad-ink":"#b0461d","bad-line":"#e2a58a",
    "err-mark":"#c4281c","warn-mark":"#b07a12","ok-mark":"#2e8540","warn-ink":"#8a5a00","sel-sub-ink":"#2b3a4d","badge-line":"#0b0b0b66","conflict-line":"#b8731d","km-warn":"#9a5b00",
    "shadow-sm":"#00000024","shadow-md":"#00000030","shadow-lg":"#00000040",backdrop:"#00000040","shadow-drawer":"#00000030",
    "swatch-edge":"#00000059","preview-edge":"#00000033","shadow-side":"#00000022","shadow-vc":"#0000002e",
    "swatch-line":"#0000004d",
    danger:"#c4281c",warning:"#8a5a00",info:"#0b62b0","danger-fill":"#c4281c","on-danger":"#ffffff",
    "msg-fatal":"#b3261e","msg-error":"#c4281c","erc-none":"#d3ead3","erc-warning":"#f6e2b3","erc-error":"#f6d0ba","erc-fatal":"#f4c4c4"
  };
  // High contrast on black: bright ink, cyan outlines, orange focus (VS Code HC).
  const HC = {
    app:"#000000",chrome:"#000000",panel:"#000000","panel-head":"#121212",raised:"#2a2a2a",hover:"#1e1e1e",field:"#000000",
    ink:"#ffffff",muted:"#dedede",faint:"#bcbcbc",line:"#8a8a8a","line-strong":"#6fc3df",soft:"#161616",
    accent:"#85bfff",selection:"#0f4c81","selection-ink":"#ffffff",focus:"#85bfff",primary:"#0e5fa8",divider:"#6fc3df",
    "menu-bg":"#000000","tab-bg":"#000000","tab-hover":"#1e1e1e","canvas-bg":"#000000","bar-bg":"#000000f5",
    "bar-line":"#6fc3df",pressed:"#2a2a2a","layer-on":"#2a2a2a","ls-bg":"#000000","ls-ink":"#ff7b70",
    button:"#000000","button-line":"#6fc3df","button-hover":"#1e1e1e","input-line":"#8a8a8a",rule:"#6f6f6f",
    "primary-line":"#6fc3df",sheet:"#ffffff",
    "ink-bright":"#ffffff","ink-strong":"#ffffff","head-ink":"#ffffff","tab-hover-ink":"#ffffff","coords-ink":"#ffffff",
    "chrome-ink":"#ffffff","tool-ink":"#ffffff","soft-ink":"#f2f2f2","icon-ink":"#ffffff","dim-ink":"#ebebeb",
    "caption-ink":"#ebebeb","tab-ink":"#ebebeb","split-ink":"#ebebeb","on-accent":"#000000","on-accent-2":"#000000",
    "on-primary":"#ffffff","accent-btn-ink":"#000000",
    "icon-folder":"#c0d0e0","icon-sch":"#a9cfff","icon-pcb":"#7ee787","error-ink":"#ff9e8f",
    "diff-changed":"#9ecbff","diff-added":"#7ee787","diff-removed":"#ffab91","ok-ink":"#7ee787","ok-line":"#7ee787",
    "warn-line":"#ffb340","bad-ink":"#ffab91","bad-line":"#ffab91",
    "err-mark":"#ff7b70","warn-mark":"#ffcc4d","ok-mark":"#7ee787","warn-ink":"#ffd75e","sel-sub-ink":"#e6eefc","badge-line":"#ffffff99","conflict-line":"#ffb340","km-warn":"#ffcc4d",
    "shadow-sm":"#000000cc","shadow-md":"#000000cc","shadow-lg":"#000000cc",backdrop:"#000000b3","shadow-drawer":"#000000cc",
    "swatch-edge":"#ffffff80","preview-edge":"#ffffff80","shadow-side":"#000000cc","shadow-vc":"#000000cc",
    "swatch-line":"#ffffff99",
    danger:"#ff6b5e",warning:"#ffb340",info:"#75beff","danger-fill":"#b3261e","on-danger":"#ffffff",
    "msg-fatal":"#ff6b5e","msg-error":"#ff8a80","erc-none":"#1f4d1f","erc-warning":"#6b5210","erc-error":"#7a3a12","erc-fatal":"#7a1f1f"
  };
  // Classic grey: a lighter, cooler Windows-era grey workspace with steel headings.
  const CLASSIC = {
    app:"#c8c8c8",chrome:"#dadada",panel:"#e9e9e9","panel-head":"#c5cbd3",raised:"#c3c9d1",hover:"#d8dee6",field:"#ffffff",
    ink:"#000000",muted:"#363636",faint:"#4f4f4f",line:"#b2b2b2","line-strong":"#8c8c8c",soft:"#dddddd",
    accent:"#104f95",selection:"#3c78b4","selection-ink":"#ffffff",focus:"#1f4f99",primary:"#2b5ea7",divider:"#a9a9a9",
    "menu-bg":"#f2f2f2","tab-bg":"#cdcdcd","tab-hover":"#dcdcdc","canvas-bg":"#000000","bar-bg":"#ecececf2",
    "bar-line":"#9a9a9a",pressed:"#c3c9d1","layer-on":"#f4f4f4","ls-bg":"#d0d0d0","ls-ink":"#9e1f17",
    button:"#e4e4e4","button-line":"#6b6b6b","button-hover":"#d6dce4","input-line":"#6a6a6a",rule:"#b4b4b4",
    "primary-line":"#1f4f99",sheet:"#fffcf8",
    "ink-bright":"#000000","ink-strong":"#000000","head-ink":"#111111","tab-hover-ink":"#111111","coords-ink":"#111111",
    "chrome-ink":"#1a1a1a","tool-ink":"#222222","soft-ink":"#262626","icon-ink":"#2b2b2b","dim-ink":"#2e2e2e",
    "caption-ink":"#333333","tab-ink":"#2e2e2e","split-ink":"#3a3a3a","on-accent":"#ffffff","on-accent-2":"#ffffff",
    "on-primary":"#ffffff","accent-btn-ink":"#ffffff",
    "icon-folder":"#475566","icon-sch":"#28558c","icon-pcb":"#1f7a33","error-ink":"#a1260d",
    "diff-changed":"#1d4f91","diff-added":"#1a6b2f","diff-removed":"#a13d12","ok-ink":"#185e28","ok-line":"#6fae7f",
    "warn-line":"#c48a2c","bad-ink":"#a13d12","bad-line":"#d08a6a",
    "err-mark":"#b3261e","warn-mark":"#9a6a10","ok-mark":"#1f7a33","warn-ink":"#704900","sel-sub-ink":"#ffffff","badge-line":"#ffffff99","conflict-line":"#a8691a","km-warn":"#8a5200",
    "shadow-sm":"#00000033","shadow-md":"#00000040","shadow-lg":"#00000052",backdrop:"#00000047","shadow-drawer":"#00000040",
    "swatch-edge":"#00000066","preview-edge":"#00000040","shadow-side":"#00000030","shadow-vc":"#00000040",
    "swatch-line":"#00000059",
    danger:"#b3261e",warning:"#7a4f00",info:"#1d4f91","danger-fill":"#b3261e","on-danger":"#ffffff",
    "msg-fatal":"#a1160d","msg-error":"#b3261e","erc-none":"#cfe5cf","erc-warning":"#f0dca8","erc-error":"#f1c8b0","erc-fatal":"#efbcbc"
  };
  // Canvas palettes per theme. PCB keys are AtriumPCBAppearance system colours; only
  // the keys listed differ from its Altium defaults. Copper colours never change.
  const SCH_STANDARD = {workspace:"#a3a3a3",paper:"#fffcf8",grid:"#e6e3dc"};
  const PRESETS = Object.freeze({
    dark:Object.freeze({id:"dark",label:"Dark",scheme:"dark",family:"dark",tokens:Object.freeze(DARK),
      canvas:{pcb:{},sch:SCH_STANDARD}}),
    light:Object.freeze({id:"light",label:"Light",scheme:"light",family:"light",tokens:Object.freeze(LIGHT),
      canvas:{pcb:{},sch:{workspace:"#cdcdcd",paper:"#ffffff",grid:"#e6e6e6"}}}),
    hc:Object.freeze({id:"hc",label:"High Contrast Dark",scheme:"dark",family:"dark",tokens:Object.freeze(HC),
      canvas:{pcb:{workspace:"#000000",workspaceGrid:"#1c1c1c",workspaceGridCoarse:"#2e2e2e",edge:"#ffffff",connection:"#e6e6e6"},
        sch:{workspace:"#000000",paper:"#ffffff",grid:"#dcdcdc"}}}),
    classic:Object.freeze({id:"classic",label:"Classic Grey",scheme:"light",family:"light",tokens:Object.freeze(CLASSIC),
      canvas:{pcb:{workspace:"#000000",workspaceGrid:"#1c1c1c",workspaceGridCoarse:"#2a2a2a"},
        sch:{workspace:"#b4b4b4",paper:"#fffcf8",grid:"#e6e3dc"}}})
  });
  const PRESET_IDS = Object.freeze(Object.keys(PRESETS));
  // Themes beyond the four CSS presets: the built-in library (theme-library.js, lazy), extension
  // themes ("ext:<extension>/<id>") and the user's own ("user:<id>"). theme-library.js resolves a
  // theme into a full token set plus canvas palettes and registers it here; the ones the settings
  // name are cached in CACHE so the saved theme paints before the first frame (no flash).
  const CACHE = "atrium.theme.cache";
  const LIBRARY = Object.freeze({ember:["dark","Ember"],fjord:["dark","Fjord"],obsidian:["dark","Obsidian"],clearview:["dark","Clearview"],
    soldermask:["dark","Soldermask"],haze:["light","Haze"],vellum:["light","Vellum"],"hc-light":["light","High Contrast Light"]});
  const OTHER_ID = /^(user|ext):[\w.:/-]{1,120}$/;
  const isThemeId = id => typeof id === "string" && (Object.hasOwn(PRESETS, id) || Object.hasOwn(LIBRARY, id) || OTHER_ID.test(id));
  const ACCENTS = Object.freeze([
    {id:"amber",label:"Amber",hex:"#f0a32e"},{id:"blue",label:"Blue",hex:"#3794ff"},{id:"teal",label:"Teal",hex:"#2bb3a3"},
    {id:"green",label:"Green",hex:"#3fb950"},{id:"purple",label:"Purple",hex:"#a371f7"},{id:"pink",label:"Pink",hex:"#e05d9b"},
    {id:"red",label:"Red",hex:"#f05349"}
  ].map(Object.freeze));
  // Row-height offsets in px: rows (list rows, fields) and bars (menu, tabs, status).
  const DENSITY = Object.freeze({compact:{row:-3,bar:-2},default:{row:0,bar:0},comfortable:{row:4,bar:4}});
  const FONT_SIZES = Object.freeze([11,12,13,14]);
  const fontRow = size => ({11:-1,12:0,13:2,14:3})[size] || 0;
  const MOTIONS = Object.freeze(["system","reduce","full","off"]);

  const DEFAULTS = Object.freeze({
    preset:"dark", followSystem:true, systemLight:"light", systemDark:"dark", accent:"",
    density:"default", fontSize:12, motion:"system",
    canvas:Object.freeze({follow:true,pcbBackground:"",schBackground:"",schSheet:""}),
    tokens:Object.freeze({})
  });

  // ------------------------------------------------------------------ colour
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const HEX6 = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  function rgba(color) {
    const s = String(color || "").trim().toLowerCase();
    if (HEX.test(s)) {
      let h = s.slice(1);
      if (h.length <= 4) h = [...h].map(c => c + c).join("");
      return [0, 2, 4, 6].map(i => i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255).map((v, i) => i === 3 ? v / 255 : v);
    }
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
    return null;
  }
  const byte = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  function hex(color) { const c = rgba(color); return c ? "#" + byte(c[0]) + byte(c[1]) + byte(c[2]) : null; }
  // Normalise a 3- or 6-digit colour to lowercase #rrggbb; anything else is null.
  function normalize(color) { return typeof color === "string" && HEX6.test(color.trim()) ? hex(color) : null; }
  function luminance(color) {
    const c = rgba(color); if (!c) return NaN;
    const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    return .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  }
  // Mix `a` toward `b` by t (0 = a, 1 = b), in sRGB like color-mix(in srgb).
  function mix(a, b, t) {
    const x = rgba(a), y = rgba(b); if (!x || !y) return null;
    return "#" + [0, 1, 2].map(i => byte(x[i] + (y[i] - x[i]) * t)).join("");
  }
  // Composite a translucent colour over an opaque background.
  function over(color, background) {
    const c = rgba(color), b = rgba(background); if (!c || !b) return null;
    return "#" + [0, 1, 2].map(i => byte(c[i] * c[3] + b[i] * (1 - c[3]))).join("");
  }
  const isDarkColor = color => luminance(color) < .18;
  const bestInk = (background, dark = "#000000", light = "#ffffff") =>
    contrast(dark, background) >= contrast(light, background) ? dark : light;
  // Move `color` away from `background` (lighter on dark, darker on light) until the
  // pair reaches `ratio`. The hue is kept; only the mix toward white or black grows.
  function ensureContrast(color, background, ratio) {
    const toward = isDarkColor(background) ? "#ffffff" : "#000000";
    let out = hex(color);
    for (let t = 0; t <= 1.0001 && contrast(out, background) < ratio; t += .04) out = mix(color, toward, t);
    return out;
  }

  const ACCENT_SURFACES = ["panel", "chrome", "menu-bg", "panel-head", "hover", "raised", "button-hover", "field", "pressed", "layer-on"];
  function accentForSurfaces(color, palette, ratio) {
    const dark = isDarkColor(palette.panel), away = dark ? "#ffffff" : "#000000";
    const backgrounds = ACCENT_SURFACES.map(key => palette[key]).filter(hex);
    let ink = hex(color);
    for (let amount = .04; amount <= 1.0001 && backgrounds.some(bg => contrast(ink, bg) < ratio); amount += .04) {
      ink = mix(color, away, amount);
    }
    return ink;
  }
  function accentRoles(palette) {
    return {"accent-text":accentForSurfaces(palette.accent, palette, 4.5),
      "accent-strong":ensureContrast(palette.accent, "#ffffff", 3)};
  }

  // Accent derivation: the accent itself (nudged to 4.5:1 on panels), a hover shade,
  // ink for text on the accent, and a selection fill tinted by the accent whose ink
  // keeps at least 4.5:1.
  function derive(accent, presetId = "dark") {
    const t = PRESETS[presetId]?.tokens || {...PRESETS[baseOf(presetId)].tokens, ...(entryOf(presetId)?.tokens || {})};
    const panel = hex(t.panel), dark = isDarkColor(panel);
    const given = normalize(accent);
    if (!given) return null;
    // Legible on panels, and text on it legible too (a mid grey fails the second).
    let a = ensureContrast(given, panel, 4.5);
    const toward = dark ? "#ffffff" : "#000000", inkOn = c => contrast(bestInk(c, "#141414", "#ffffff"), c);
    for (let i = 0; i < 25 && inkOn(a) < 4.5; i++) a = mix(a, toward, .08);
    const control = ensureContrast(given, panel, 3);
    const preferredControlInk = bestInk(control, "#141414", "#ffffff");
    const controlInk = contrast(preferredControlInk, control) >= 4.5 ? preferredControlInk : bestInk(control);
    // Primary: white ink (macOS); light hues keep dark ink.
    const light = contrast("#ffffff", control) * 2 < contrast("#141414", control);
    const primary = light ? control : ensureContrast(control, "#ffffff", 4.5), onPrimary = light ? controlInk : "#ffffff";
    const focus = accentForSurfaces(control, t, 3);
    const hover = mix(control, dark ? "#ffffff" : "#000000", .16);
    const onAccent = bestInk(a, "#141414", "#ffffff");
    // Theme ink first (white on dark panels); the other extreme only if it reads better.
    const preferred = dark ? "#ffffff" : hex(t.ink);
    let selection = null, selectionInk = null;
    for (let k = dark ? .42 : .26; k >= .08; k -= .02) {
      const fill = mix(panel, control, k), ink = contrast(preferred, fill) >= 4.5 ? preferred : bestInk(fill);
      if (contrast(ink, fill) >= 4.5) { selection = fill; selectionInk = ink; break; }
    }
    if (!selection) { selection = mix(panel, control, .08); selectionInk = bestInk(selection); }
    return {accent:a, adjusted:a !== given, hover, onAccent, control, controlInk, primary, onPrimary, focus, selection, selectionInk,
      contrast:{accent:+contrast(a, panel).toFixed(2), onAccent:+contrast(onAccent, a).toFixed(2),
        selection:+contrast(selectionInk, selection).toFixed(2)}};
  }

  // ------------------------------------------------------------------ settings
  const clone = s => JSON.parse(JSON.stringify(s));
  const plain = v => !!v && typeof v === "object" && !Array.isArray(v);
  const TOKEN_KEYS = new Set([...TOKENS, ...OPTIONAL, ...SCOPED]);
  const TOP_KEYS = new Set(["atrium-theme","name","preset","followSystem","systemLight","systemDark","accent","density",
    "fontSize","motion","canvas","tokens"]);
  const CANVAS_KEYS = new Set(["follow","pcbBackground","schBackground","schSheet"]);
  // Validate a settings object (or an imported theme). Known keys only; colours must
  // be hex. Returns {ok, errors, value}: every problem is listed, and `value` keeps
  // what was valid (stored settings load leniently from it; imports require ok).
  function validate(input) {
    const errors = [], out = clone(DEFAULTS);
    const bad = msg => errors.push(msg);
    if (!plain(input)) return {ok:false, errors:["A theme must be a JSON object."], value:out};
    for (const k of Object.keys(input)) if (!TOP_KEYS.has(k)) bad("Unknown key \"" + k + "\".");
    if ("atrium-theme" in input && input["atrium-theme"] !== FORMAT) bad("Unsupported theme format " + JSON.stringify(input["atrium-theme"]) + ".");
    if ("name" in input && (typeof input.name !== "string" || input.name.length > 80)) bad("\"name\" must be a short string.");
    else if (input.name) out.name = input.name;
    const choice = (key, list, target = out) => {
      if (!(key in input)) return;
      if (list.includes(input[key])) target[key] = input[key]; else bad("\"" + key + "\" must be one of " + list.join(", ") + ".");
    };
    if ("preset" in input) {
      if (isThemeId(input.preset)) {
        out.preset = input.preset;
        if (!("followSystem" in input)) out.followSystem = false;
      } else bad("\"preset\" must be a theme id (" + PRESET_IDS.join(", ") + ", …).");
    }
    choice("density", Object.keys(DENSITY));
    choice("motion", MOTIONS);
    for (const [key, fam] of [["systemLight", "light"], ["systemDark", "dark"]]) if (key in input) {
      if (isThemeId(input[key]) && (familyOf(input[key]) || fam) === fam) out[key] = input[key]; else bad("\"" + key + "\" must be a " + fam + " theme.");
    }
    if ("followSystem" in input) { if (typeof input.followSystem === "boolean") out.followSystem = input.followSystem; else bad("\"followSystem\" must be true or false."); }
    if ("fontSize" in input) { if (FONT_SIZES.includes(input.fontSize)) out.fontSize = input.fontSize; else bad("\"fontSize\" must be 11, 12, 13 or 14."); }
    const color = (value, label) => {
      if (value == null || value === "") return "";
      const c = normalize(value);
      if (!c) bad(label + " must be a hex colour like #3794ff.");
      return c || "";
    };
    if ("accent" in input) out.accent = color(input.accent, "\"accent\"");
    if ("canvas" in input) {
      const c = input.canvas;
      if (!plain(c)) bad("\"canvas\" must be an object.");
      else {
        for (const k of Object.keys(c)) if (!CANVAS_KEYS.has(k)) bad("Unknown key \"canvas." + k + "\".");
        if ("follow" in c) { if (typeof c.follow === "boolean") out.canvas.follow = c.follow; else bad("\"canvas.follow\" must be true or false."); }
        for (const k of ["pcbBackground","schBackground","schSheet"]) if (k in c) out.canvas[k] = color(c[k], "\"canvas." + k + "\"");
        // Schematic inks (navy wires, maroon parts, green selection) need a light sheet.
        if (out.canvas.schSheet && luminance(out.canvas.schSheet) < .6) {
          bad("\"canvas.schSheet\" must be a light colour so schematic ink stays legible."); out.canvas.schSheet = "";
        }
      }
    }
    if ("tokens" in input) {
      const t = input.tokens;
      if (!plain(t)) bad("\"tokens\" must be an object.");
      else for (const [k, v] of Object.entries(t)) {
        const name = k.replace(/^--/, "");
        if (!TOKEN_KEYS.has(name)) { bad("Unknown token \"" + k + "\"."); continue; }
        if (typeof v !== "string" || !HEX.test(v.trim())) { bad("Token \"" + k + "\" must be a hex colour."); continue; }
        out.tokens[name] = v.trim().toLowerCase();
      }
    }
    // Following the system keeps the chosen preset in step with its family slot.
    if (!out.followSystem) {
      if (familyOf(out.preset) === "light") out.systemLight = out.preset; else out.systemDark = out.preset;
    }
    return {ok:!errors.length, errors, value:out};
  }

  // ------------------------------------------------------------------ state
  let storage = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  let settings = clone(DEFAULTS);
  const listeners = new Set();
  const media = (() => {
    try { return typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-color-scheme: light)") : null; }
    catch { return null; }
  })();
  let systemPrefersLight = () => !!media?.matches;

  // ---- registered themes: id -> {name, base, family, scheme, tokens, syntax, pcb, sch}
  const entries = new Map();
  let resolver = null, lastCache = null, library = null;
  const familyOf = id => PRESETS[id]?.family || LIBRARY[id]?.[0] || entries.get(id)?.family || null;
  const baseOf = id => PRESETS[id] ? id : entries.get(id)?.base || (familyOf(id) === "light" ? "light" : "dark");
  const schemeOf = id => PRESETS[id]?.scheme || entries.get(id)?.scheme || familyOf(id) || "dark";
  // Only colours reach the page: known token names with hex values (a stored cache is input too).
  function cleanEntry(e) {
    if (!plain(e) || !PRESETS[e.base]) return null;
    const hexes = (o, ok) => { const m = {}; if (plain(o)) for (const [k, v] of Object.entries(o)) if (ok(k) && typeof v === "string" && HEX.test(v)) m[k] = v.toLowerCase(); return m; };
    const name = k => typeof k === "string" && k.length < 40 && /^[\w -]+$/.test(k);
    const pcb = hexes(e.pcb, k => k !== "layers" && name(k));
    pcb.layers = hexes(e.pcb?.layers, name);
    return {name: typeof e.name === "string" ? e.name.slice(0, 80) : "", base: e.base, family: e.family === "light" ? "light" : "dark",
      scheme: e.scheme === "light" ? "light" : "dark", tokens: hexes(e.tokens, k => TOKEN_KEYS.has(k)), syntax: hexes(e.syntax, k => /^[a-z]{2,16}$/.test(k)),
      pcb, sch: hexes(e.sch, k => k === "workspace" || k === "paper" || k === "grid")};
  }
  function register(id, e, persist = true) {
    if (!isThemeId(id) || PRESETS[id]) return false;
    const c = cleanEntry(e); if (!c) return false;
    entries.set(id, c); if (persist) saveCache(); return true;
  }
  function entryOf(id) {
    if (PRESETS[id]) return null;
    if (!entries.has(id) && resolver) { try { const e = resolver(id); if (e) register(id, e, false); } catch {} }
    return entries.get(id) || null;
  }
  function loadCache() {
    try { const o = JSON.parse(storage?.getItem(CACHE) || "{}"); if (plain(o)) for (const [id, e] of Object.entries(o)) if (isThemeId(id) && !PRESETS[id]) { const c = cleanEntry(e); if (c) entries.set(id, c); } } catch {}
  }
  function saveCache() {
    const keep = {};
    for (const id of new Set([effectivePreset(), settings.preset, settings.systemLight, settings.systemDark])) if (entries.has(id)) keep[id] = entries.get(id);
    const text = JSON.stringify(keep);
    if (text === lastCache) return;
    lastCache = text;
    try { if (Object.keys(keep).length) storage?.setItem(CACHE, text); else storage?.removeItem?.(CACHE); } catch {}
  }
  // The theme library loads when the saved theme is not cached (first start after an update).
  function needLibrary() {
    const id = effectivePreset();
    if (library || PRESETS[id] || entries.has(id) || !dom) return;
    const L = globalThis.AtriumLazy; if (!L?.need) return;
    library = L.need("AtriumThemes").then(() => apply("resolve"), () => { library = null; });
  }

  function load() {
    loadCache();
    let raw = null;
    try { raw = storage?.getItem(STORE); } catch {}
    if (!raw) { settings = clone(DEFAULTS); return; }
    try { settings = validate(JSON.parse(raw)).value; } catch { settings = clone(DEFAULTS); }
  }
  function save() {
    try {
      if (JSON.stringify(settings) === JSON.stringify(DEFAULTS)) storage?.removeItem?.(STORE);
      else storage?.setItem(STORE, JSON.stringify(settings));
    } catch {}
  }
  const effectivePreset = (s = settings) => s.followSystem ? (systemPrefersLight() ? s.systemLight : s.systemDark) : s.preset;

  const accentFor = (s,id) => s.accent || (PRESETS[id] && globalThis.__atriumHostAccent);
  function inlineTokens(s = settings) {
    const id = effectivePreset(s), out = {}, e = entryOf(id);
    if (e) { Object.assign(out, e.tokens); for (const [k, v] of Object.entries(e.syntax)) out["syn-" + k] = v; }
    const d = derive(accentFor(s,id),id);
    if (d) Object.assign(out, {accent:d.control, "accent-hover":d.hover, "on-accent":d.controlInk, "on-accent-2":d.controlInk,
      "accent-btn-ink":d.controlInk, focus:d.focus, primary:d.primary, "primary-line":d.focus, "on-primary":d.onPrimary,
      selection:d.selection, "selection-ink":d.selectionInk, "sel-sub-ink":mix(d.selectionInk, d.selection, .12)});
    for (const [k, v] of Object.entries(s.tokens || {})) out[k] = v;
    if (Object.keys(out).length) Object.assign(out, accentRoles({...PRESETS[baseOf(id)].tokens, ...out}));
    return out;
  }
  // Every token value for a settings object: preset, then accent, then overrides.
  function tokensFor(s = settings) {
    const id = effectivePreset(s), base = {...PRESETS[baseOf(id)].tokens, ...(entryOf(id)?.tokens || {})}, out = {};
    for (const k of TOKENS) out[k] = base[k] ?? DARK[k];
    if (out.divider === "var(--app)") out.divider = out.app;
    const d = derive(accentFor(s,id),id);
    out["accent-hover"] = d ? d.hover : mix(out.accent, isDarkColor(hex(out.panel)) ? "#ffffff" : "#000000", .16);
    const all = Object.assign(out, inlineTokens(s));
    if (!all["accent-text"]) Object.assign(all, accentRoles(all));
    for (const k of Object.keys(all)) if (k.startsWith("syn-")) delete all[k];
    return all;
  }
  // Canvas colours for "pcb" (AtriumPCBAppearance system keys) or "sch"
  // ({workspace, paper, grid}).
  function canvasPalette(kind, s = settings) {
    const id = effectivePreset(s), c = s.canvas || DEFAULTS.canvas, e = c.follow ? entryOf(id) : null;
    const source = !c.follow ? PRESETS.dark.canvas : PRESETS[id]?.canvas || (e ? {pcb:e.pcb, sch:e.sch} : PRESETS[baseOf(id)].canvas);
    if (kind === "pcb") {
      const out = {...source.pcb};
      if (out.layers) out.layers = {...out.layers};
      if (c.pcbBackground) {
        const bg = c.pcbBackground, toward = isDarkColor(bg) ? "#ffffff" : "#000000";
        Object.assign(out, {workspace:bg, workspaceGrid:mix(bg, toward, .045), workspaceGridCoarse:mix(bg, toward, .09)});
      }
      return out;
    }
    const out = {...source.sch};
    if (c.schBackground) out.workspace = c.schBackground;
    if (c.schSheet) { out.paper = c.schSheet; out.grid = mix(c.schSheet, "#000000", .1); }
    return out;
  }

  // ------------------------------------------------------------------ apply
  const appliedInline = new Set();
  function applyMotion() {
    if (settings.motion === "system") root?.removeAttribute("data-motion");
    else root?.setAttribute("data-motion", settings.motion);
  }
  function applyRoot() {
    if (!root) return;
    const id = effectivePreset();
    try {
      root.setAttribute("data-theme", baseOf(id));
      if (PRESETS[id]) root.removeAttribute("data-theme-id"); else root.setAttribute("data-theme-id", id);
      root.setAttribute("data-density", settings.density);
      root.setAttribute("data-ui-font", String(settings.fontSize));
      applyMotion();
      const inline = inlineTokens();
      for (const k of appliedInline) if (!(k in inline)) root.style?.removeProperty("--" + k);
      appliedInline.clear();
      for (const [k, v] of Object.entries(inline)) { root.style?.setProperty("--" + k, v); appliedInline.add(k); }
      const meta = doc.querySelector?.('meta[name="color-scheme"]');
      if (meta) meta.setAttribute("content", schemeOf(id));
    } catch {}
  }
  function applyCanvas() {
    try { globalThis.AtriumPCBAppearance?.setThemeBase?.(canvasPalette("pcb")); } catch {}
    try { globalThis.AtriumSchAppearance?.setTheme?.(canvasPalette("sch")); } catch {}
  }
  function emit(reason) {
    const detail = {reason, preset:effectivePreset(), settings:get()};
    for (const fn of listeners) { try { fn(detail); } catch {} }
    try {
      if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function")
        globalThis.dispatchEvent(new CustomEvent("atrium-theme", {detail}));
    } catch {}
  }
  let paintedTheme;
  function apply(reason = "change") {
    const id = effectivePreset(), key = JSON.stringify([id,accentFor(settings,id),settings.tokens,settings.canvas,settings.density,settings.fontSize]);
    const run = () => {
      paintedTheme = key;
      applyRoot(); applyCanvas(); saveCache(); syncControls(); emit(reason); needLibrary();
    };
    if (reason !== "apply" && globalThis.AtriumMotion?.crossFade)
      globalThis.AtriumMotion.crossFade(run,{from:paintedTheme,to:key,animate:settings.motion !== "off"});
    else run();
  }

  // ------------------------------------------------------------------ API
  function get() { return clone(settings); }
  // Merge a partial settings object; invalid input throws with every problem listed.
  function set(partial, {persist = true, reason = "change"} = {}) {
    if (!plain(partial)) throw Error("Theme settings must be an object.");
    const merged = {...settings, ...partial,
      canvas:{...settings.canvas, ...(plain(partial.canvas) ? partial.canvas : {})},
      tokens:"tokens" in partial ? partial.tokens : settings.tokens};
    if ("preset" in partial && !("followSystem" in partial)) merged.followSystem = false;
    // Choosing a preset drops an imported theme's colours (and its name) unless they come along.
    if ("preset" in partial && !("tokens" in partial)) { merged.tokens = {}; if (!("name" in partial)) delete merged.name; }
    const r = validate(merged);
    if (!r.ok) throw Error(r.errors.join(" "));
    settings = r.value;
    if (persist) save();
    if (Object.keys(partial).length === 1 && "motion" in partial) {
      // The open panel previews this change. Repainting palettes and cross-fading the
      // entire window here would obscure the difference between the motion levels.
      applyMotion(); emit(reason);
    } else apply(reason);
    return get();
  }
  const setPreset = id => set({preset:id});
  // Quick switch between the light and dark family (the last preset used in each).
  function toggle() {
    const family = familyOf(effectivePreset()) || "dark";
    return set({preset:family === "dark" ? settings.systemLight : settings.systemDark, followSystem:false});
  }
  function reset() { settings = clone(DEFAULTS); save(); apply("reset"); return get(); }
  function exportJSON(s = settings) {
    const out = {"atrium-theme":FORMAT, ...clone(s)};
    if (!Object.keys(out.tokens || {}).length) delete out.tokens;
    return JSON.stringify(out, null, 2);
  }
  // Parse, validate and apply a theme file. Missing keys take their defaults.
  function parseJSON(text) {
    let data;
    try { data = typeof text === "string" ? JSON.parse(text) : text; } catch (e) { throw Error("The theme file is not valid JSON."); }
    const r = validate(data);
    if (!r.ok) throw Error(r.errors.join(" "));
    return r.value;
  }
  function importJSON(text) {
    settings = parseJSON(text); save(); apply("import"); return get();
  }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Pre-paint: this file runs in <head>; load() and applyRoot() below set the attributes and any cached
  // theme colours before the first paint (no separate inline snippet; it could not read the cache).

  // ------------------------------------------------------------------ UI
  // The Appearance page, the theme picker (Ctrl/⌘+K Ctrl/⌘+T) and the theme editor are lazy
  // (theme-picker.js, theme-editor.js); these shims load them on first use.
  const lazyUI = name => { const L = globalThis.AtriumLazy; return globalThis[name] ? Promise.resolve(globalThis[name]) : L?.need ? L.need(name) : Promise.reject(Error("The appearance settings are not available.")); };
  function syncControls() { syncMenus(); try { globalThis.AtriumThemePicker?.sync?.(); } catch {} }
  // The Appearance page for the Preferences dialog (prefs.js): filled once the gallery has loaded.
  function appearancePage() {
    if (!dom || !doc.body) return null;
    const page = doc.createElement("div"); page.className = "thp-page";
    lazyUI("AtriumThemePicker").then(G => G.appearancePage(page), e => { page.textContent = e.message; });
    return page;
  }
  const say = e => globalThis.AtriumNavHost?.info?.(e.message);
  function open(page = "appearance") {
    if (!dom || !doc.body) return null;
    return lazyUI("AtriumPrefs").then(P => P.open(page)).catch(say);
  }
  // Built-in library themes by id: the theme library selects them (it loads on first use).
  function useLibrary(id) { lazyUI("AtriumThemes").then(L => L.select(id), say); }

  // Menu entries (View → theme presets, File → Preferences…).
  // They are added here so index.html stays untouched; each is added once.
  const ACTIONS = {"theme-toggle":toggle, preferences:() => open(null), "theme-follow-system":() => set({followSystem:!settings.followSystem})};
  for (const id of PRESET_IDS) ACTIONS["theme-" + id] = () => setPreset(id);
  for (const id of Object.keys(LIBRARY)) ACTIONS["theme-" + id] = () => useLibrary(id);
  function menuButton(action, text, radio) {
    const b = doc.createElement("button"); b.textContent = text; b.type = "button"; b.dataset.action = action;
    b.setAttribute("role", radio ? "menuitemradio" : "menuitem"); return b;
  }
  function installMenus() {
    const view = doc.querySelector('.work-menu[data-menu="view"] .menu-items');
    if (view && !view.querySelector('[data-action="theme-toggle"]')) {
      view.append(doc.createElement("hr"));
      for (const id of PRESET_IDS) view.append(menuButton("theme-" + id, "Theme: " + PRESETS[id].label, true));
      view.append(menuButton("theme-follow-system", "Theme: Follow system", true));
      view.append(menuButton("theme-toggle", "Toggle light/dark theme"));
    }
    const file = doc.querySelector('.work-menu[data-menu="file"] .menu-items');
    if (file && !file.querySelector('[data-action="preferences"]')) file.append(doc.createElement("hr"), menuButton("preferences", "Preferences…"));
  }
  function syncMenus() {
    if (!dom) return;
    const id = effectivePreset();
    try {
      for (const pid of [...PRESET_IDS, ...Object.keys(LIBRARY)]) for (const b of doc.querySelectorAll('[data-action="theme-' + pid + '"]'))
        b.setAttribute("aria-checked", String(!settings.followSystem && pid === id));
      for (const b of doc.querySelectorAll('[data-action="theme-follow-system"]')) b.setAttribute("aria-checked", String(settings.followSystem));
    } catch {}
  }
  const themeName = id => PRESETS[id]?.label || LIBRARY[id]?.[1] || entries.get(id)?.name || "Custom theme";
  function registerCommands() {
    const km = globalThis.AtriumKeymap;
    if (!km?.registerCommand) return;
    const add = spec => { try { if (!km.command?.(spec.id)) km.registerCommand(spec); } catch {} };
    add({id:"theme-toggle", title:"Toggle light/dark theme", category:"View", run:ACTIONS["theme-toggle"]});
    add({id:"theme-preferences", title:"Appearance preferences…", category:"View", run:() => open()});
  }
  function run(action) { const fn = typeof action === "string" && Object.hasOwn(ACTIONS, action) && ACTIONS[action]; if (!fn) return false; try { fn(); } catch (e) { globalThis.console?.warn?.(e); } return true; }

  // ------------------------------------------------------------------ boot
  load();
  if (dom) {
    applyRoot();
    media?.addEventListener?.("change", () => { if (settings.followSystem) apply("system"); });
    const ready = () => {
      try {
        installMenus(); registerCommands(); applyCanvas(); syncMenus(); needLibrary();
        doc.addEventListener("click", e => {
          const b = /** @type {Element | null} */ (e.target)?.closest?.("[data-action]");
          if (b && !("disabled" in b && b.disabled)) run(b.getAttribute("data-action"));
        });
        globalThis.addEventListener?.("atrium-command", e => run("detail" in e ? e.detail : null));
      } catch (e) { globalThis.console?.warn?.("Waffle theme controls unavailable", e); }
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", ready, {once:true}); else ready();
  }

  return Object.freeze({
    STORE, FORMAT, PRESETS, PRESET_IDS, ACCENTS, TOKENS, OPTIONAL, SCOPED, SCOPE_SELECTOR, DENSITY, FONT_SIZES, MOTIONS, DEFAULTS,
    LIBRARY, CACHE, isThemeId, familyOf, baseOf, themeName, register, entry:id => entryOf(id), useResolver(fn) { resolver = typeof fn === "function" ? fn : null; },
    fontRow, appearancePage, get, set, setPreset, toggle, reset, effectivePreset:() => effectivePreset(), tokensFor, inlineTokens, canvasPalette,
    derive, accentRoles, validate, exportJSON, importJSON, parseJSON, onChange, open, run, apply:() => apply("apply"),
    color:Object.freeze({rgba, hex, normalize, luminance, contrast, mix, over, ensureContrast, bestInk}),
    // Tests: a storage object and a stand-in for prefers-color-scheme.
    useStorage(s) { storage = s; load(); },
    setSystemPreference(light) { systemPrefersLight = () => !!light; }
  });
})();

// AtriumPref: preference reads and writes for eagerly loaded modules (autosave, editor,
// schematic placement, router) before prefs.js, which loads lazily, has arrived. Once it has,
// both calls go through AtriumPrefs (validation, change events). Before then a read takes the
// stored "atrium.prefs" value or `fallback`, and a write updates that store directly; a store
// created this way is marked so prefs.js still runs its one-time migration of older keys.
// envelope() is that stored object for AtriumPrefs.load. legacyValue() is a value from it for
// readers that run before the Preferences module has loaded.
globalThis.AtriumPref = (() => {
  const STORE = "atrium.prefs", FORMAT = "atrium-prefs";
  const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
  function envelope(storage = ls()) {
    try { return JSON.parse(storage?.getItem(STORE) || "null"); } catch { return null; }
  }
  function raw() {
    const o = envelope();
    return o?.format === FORMAT && o.values && typeof o.values === "object" ? o : null;
  }
  function legacyValue(key, storage) {
    const values = envelope(storage)?.values;
    if (!values || typeof values !== "object" || !Object.prototype.hasOwnProperty.call(values, key)) return undefined;
    return values[key];
  }
  function get(key, fallback) {
    const P = globalThis.AtriumPrefs;
    const v = P ? P.get(key) : raw()?.values?.[key];
    return v === undefined ? fallback : v;
  }
  function set(key, value) {
    const P = globalThis.AtriumPrefs;
    if (P) { try { return P.set(key, value); } catch { return get(key); } }
    try {
      const o = raw() || {format:FORMAT, version:1, values:{}, migrate:true};
      o.values[key] = value; ls()?.setItem(STORE, JSON.stringify(o));
    } catch {}
    return value;
  }
  return Object.freeze({get, set, envelope, legacyValue});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumPref;
