"use strict";
// AtriumThemes (app/editor/theme-library.js): the atrium-theme v1 schema and its validation (untrusted
// input: colours only), derivation from a few base colours, the built-in themes, user and extension
// themes, the pre-paint cache in AtriumTheme, and the copper-layer ΔE report.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh theme-library).
const assert = require("node:assert/strict");
const store = new Map(), storage = {getItem:k => store.has(k) ? store.get(k) : null, setItem:(k, v) => store.set(k, String(v)), removeItem:k => store.delete(k)};
Object.defineProperty(globalThis, "localStorage", {value:storage, configurable:true, writable:true});
require("../../app/core/model.js");
require("../../app/editor/theme.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/schematic/sch-appearance.js");
require("../../app/editor/theme-library.js");
const T = AtriumTheme, L = AtriumThemes, C = T.color, PCB = AtriumPCBAppearance;
T.useStorage(storage);

// ---- registry: four CSS presets and eight library themes, original names only.
const ids = L.list().map(x => x.id);
for (const id of ["dark", "light", "hc", "classic", "ember", "fjord", "obsidian", "haze", "vellum", "clearview", "hc-light", "soldermask"]) assert.ok(ids.includes(id), id + " listed");
assert.deepEqual(Object.keys(T.LIBRARY).sort(), L.BUILTIN_IDS.slice().sort(), "theme.js knows every library id (validation before the library loads)");
for (const id of L.BUILTIN_IDS) assert.equal(T.LIBRARY[id][1], L.get(id).doc.name, id + " label agrees");
assert.equal(L.list({family:"light"}).every(x => x.type === "light" || x.type === "hc-light"), true);

// ---- every resolved theme: all tokens, hex only, text 4.5:1, no warnings on built-ins.
for (const id of L.BUILTIN_IDS) {
  const r = L.resolved(id);
  for (const k of T.TOKENS) assert.match(r.tokens[k], /^#[0-9a-f]{6}([0-9a-f]{2})?$/, id + " --" + k);
  assert.deepEqual(r.report.warnings, [], id + " has no contrast warnings");
  for (const c of r.report.contrast) assert.ok(c.ratio >= c.min - 1e-9, id + " --" + c.token + " on --" + c.on + " " + c.ratio);
  assert.ok(C.luminance(r.canvas.sch.paper) >= .6, id + " sheet stays light");
}
// Copper layers: distinct, and Clearview stays distinct with deuteranopia.
for (const id of L.BUILTIN_IDS) if (L.get(id).doc.canvas?.pcb?.layers) assert.ok(L.resolved(id).report.layers.minDeltaE >= 25, id + " ΔE " + L.resolved(id).report.layers.minDeltaE);
assert.ok(L.resolved("clearview").report.layers.minDeltaEDeuteranopia >= 25, "Clearview under deuteranopia");
assert.ok(L.deltaE("#ff0000", "#ff0000") < 1e-9 && L.deltaE("#000000", "#ffffff") > 99);
assert.equal(L.deuteranopia("#000000"), "#000000");

// ---- derivation: a few base colours give a legible theme of every type.
for (const type of L.TYPES) for (const surface of /dark/.test(type) ? ["#000000", "#101010", "#2a2f3a", "#3a0a2a", "#6a6a6a"] : ["#ffffff", "#d8d8d8", "#f0e6d0", "#a8a8a8"]) {
  const v = L.validate({"atrium-theme":1, name:"T", type, palette:{surface, accent:"#808080"}});
  assert.ok(v.ok, v.errors.join(" "));
  const r = L.resolve(v.doc);
  for (const c of r.report.contrast) assert.ok(c.ratio >= c.min - 1e-9, type + " " + surface + " --" + c.token + " on --" + c.on + " " + c.ratio);
}

// ---- validation: known keys, hex colours, nothing that could become CSS text.
const ok = d => L.validate({"atrium-theme":1, name:"X", type:"dark", ...d});
assert.equal(ok({}).ok, true);
assert.ok(ok({palette:{surface:"#f0f0f0"}}).warnings.some(w => /light/.test(w)), "a light surface on a dark theme is flagged");
assert.equal(L.validate([]).ok, false);
assert.equal(L.validate({"atrium-theme":2, name:"X", type:"dark"}).ok, false, "format version");
assert.equal(ok({type:"sepia"}).ok, false, "type");
assert.equal(ok({script:"alert(1)"}).ok, false, "unknown key");
for (const bad of ["red", "rgb(1,2,3)", "#ff0000;}body{display:none", "url(x)", "var(--ink)", "#12", " #fff;", "expression(1)"])
  assert.equal(ok({colors:{panel:bad}}).ok, false, "rejects " + bad);
assert.equal(ok({colors:{"--panel":"#ABCDEF"}}).doc.colors.panel, "#abcdef", "dashes and case are normalised");
assert.equal(ok({colors:{"evil-token":"#ffffff"}}).ok, false, "unknown token");
assert.equal(ok({palette:{surface:"#ffffff80"}}).ok, false, "base colours are opaque");
assert.equal(ok({canvas:{pcb:{layers:{"Inner 3":"#ff00ff", "Top":"#00ff00"}}}}).ok, true);
assert.equal(ok({canvas:{pcb:{layers:{"<img>":"#ff00ff"}}}}).ok, false, "layer names are a fixed set");
assert.equal(ok({canvas:{pcb:{layers:{"Inner 127":"#ff00ff"}}}}).ok, false);
assert.equal(ok({canvas:{sch:{paper:"#202020"}}}).ok, false, "dark sheet");
assert.equal(ok({canvas:{pcb:{system:{board:"#000"}}}}).doc.canvas.pcb.system.board, "#000000");
assert.equal(ok({name:"x".repeat(81)}).ok, false);
assert.equal(ok({name:"Tab\tname"}).doc.name, "Tabname", "control characters are dropped");
assert.equal(ok({syntax:{keyword:"#c586c0", nope:"#000000"}}).ok, false);
const many = L.validate({"atrium-theme":1, type:"x", zzz:1, colors:{panel:"red"}});
assert.ok(many.errors.length >= 4, "every problem is reported");

// ---- extends, iconTint, explicit colours that fail contrast are reported (not silently changed).
const child = L.resolve(ok({extends:"ember", colors:{muted:"#3a3a3a"}, iconTint:"#ff8800"}).doc);
assert.equal(child.tokens.panel, L.resolved("ember").tokens.panel, "inherits");
assert.equal(child.tokens.muted, "#3a3a3a", "explicit colour kept");
assert.ok(child.report.warnings.some(w => /--muted on --panel/.test(w)), "and reported");
assert.equal(child.tokens["icon-ink"], "#ff8800");
assert.ok(L.resolve(ok({extends:"missing-theme"}).doc).report.warnings.length, "missing base theme is reported");

// ---- selecting a library theme: inline tokens, base CSS block, canvas palettes, cache.
L.select("ember");
assert.equal(T.effectivePreset(), "ember");
assert.equal(T.baseOf("ember"), "dark");
assert.equal(T.inlineTokens().panel, L.resolved("ember").tokens.panel);
assert.ok(T.inlineTokens()["syn-keyword"], "syntax colours become --syn-* properties");
assert.equal(T.tokensFor().panel, L.resolved("ember").tokens.panel);
assert.equal(PCB.color("Top"), L.resolved("ember").canvas.pcb.layers.Top, "theme layer colours reach the board");
assert.equal(PCB.system.board, L.resolved("ember").canvas.pcb.system.board);
assert.equal(AtriumSchAppearance.paper, L.resolved("ember").canvas.sch.paper);
PCB.setColor("Top", "#123456");
assert.equal(PCB.color("Top"), "#123456", "View Configuration overrides sit on top of the theme");
PCB.reset();
assert.equal(PCB.color("Top"), L.resolved("ember").canvas.pcb.layers.Top);
const cache = JSON.parse(store.get(T.CACHE));
assert.ok(cache.ember?.tokens?.panel, "the theme in use is cached for the next start");
let painted = 0; PCB.withPalette({board:"#010203", layers:{Top:"#0a0b0c"}}, () => { painted = 1; assert.equal(PCB.color("Top"), "#0a0b0c"); assert.equal(PCB.system.board, "#010203"); });
assert.equal(painted, 1); assert.equal(PCB.color("Top"), L.resolved("ember").canvas.pcb.layers.Top, "withPalette restores");
T.set({preset:"dark"});
assert.equal(PCB.color("Top"), PCB.defaultColor("Top") === "#ff0000" ? "#ff0000" : PCB.color("Top"), "legacy presets keep the Altium layers");
assert.equal(PCB.color("Top"), "#ff0000");
assert.equal(store.has(T.CACHE), false, "nothing cached for a CSS preset");

// Pre-paint: a cached theme the library has never seen applies from storage alone (fresh start).
const fake = {name:"Cached", base:"light", family:"light", scheme:"light", tokens:{panel:"#fafafa", ink:"#101010", "evil":"#000000", app:"url(x)"}, syntax:{}, pcb:{board:"#111111", layers:{Top:"#00aa00"}}, sch:{paper:"#ffffff"}};
store.set(T.CACHE, JSON.stringify({"user:cached":fake}));
store.set(T.STORE, JSON.stringify({preset:"user:cached"}));
T.useStorage(storage);
assert.equal(T.effectivePreset(), "user:cached");
assert.equal(T.inlineTokens().panel, "#fafafa");
assert.ok(!("evil" in T.inlineTokens()) && !("app" in T.inlineTokens()), "the cache is filtered: known tokens, hex values");
assert.equal(T.baseOf("user:cached"), "light");
T.set({preset:"dark"});

// ---- follow the OS, with a preferred light and dark theme of any kind.
T.set({followSystem:true, systemLight:"vellum", systemDark:"obsidian"});
T.setSystemPreference(true); assert.equal(T.effectivePreset(), "vellum");
T.setSystemPreference(false); assert.equal(T.effectivePreset(), "obsidian");
assert.equal(T.validate({systemLight:"obsidian"}).ok, false, "a dark theme is not a light preference");
L.select("fjord"); assert.equal(T.get().followSystem, true, "picking a theme of the current kind keeps following");
assert.equal(T.get().systemDark, "fjord");
L.select("haze"); assert.equal(T.get().followSystem, false, "a theme of the other kind stops following, so it shows");
assert.equal(T.effectivePreset(), "haze");
T.set({preset:"dark"});

// ---- user themes (the editor) and import.
const uid = L.saveUser({"atrium-theme":1, name:"My Theme", type:"light", extends:"haze", colors:{accent:"#7a3a9a"}});
assert.equal(uid, "user:my-theme");
assert.equal(L.saveUser({"atrium-theme":1, name:"My Theme", type:"light"}), "user:my-theme-2", "names stay unique");
assert.ok(JSON.parse(store.get("atrium.themes.user")).some(r => r.id === uid), "saved");
assert.throws(() => L.saveUser({"atrium-theme":1, name:"Bad", type:"dark", colors:{panel:"red"}}), /hex/);
const flat = L.document(uid);
assert.equal(Object.keys(flat.colors).length, T.TOKENS.filter(k => /^#/.test(L.resolved(uid).tokens[k])).length, "export is self-contained");
assert.ok(!("extends" in flat));
assert.ok(L.validate(flat).ok, "an export validates");
assert.equal(L.removeUser("user:my-theme-2"), true);
globalThis.__testDone = (async () => {
  const r = await L.importText(L.exportJSON("vellum").replace('"Vellum"', '"Vellum copy"'));
  assert.equal(r.id, "user:vellum-copy"); assert.equal(T.effectivePreset(), "user:vellum-copy");
  await assert.rejects(L.importText('{"atrium-theme":1,"name":"x","type":"dark","colors":{"panel":"javascript:1"}}'), /hex/);
  await assert.rejects(L.importText("x".repeat(600 * 1024)), /larger/);
  const s = await L.importText('{"atrium-theme":1,"preset":"light"}');
  assert.equal(s.settings, true); assert.equal(T.effectivePreset(), "light", "an appearance-settings file still imports");

  // ---- extension themes: data only, validated, namespaced, removed with the extension.
  const ext = L.registerExtension("pub.pack", [{id:"night", label:"Night", theme:{"atrium-theme":1, name:"Night", type:"dark", palette:{surface:"#101820"}}},
    {id:"bad", label:"Bad", theme:{"atrium-theme":1, name:"Bad", type:"dark", colors:{panel:"expression(alert(1))"}}}, {id:"../x", label:"Path", theme:{}}]);
  assert.deepEqual(ext.ids, ["ext:pub.pack/night"]);
  assert.equal(ext.errors.length, 2);
  assert.equal(L.get("ext:pub.pack/night").source, "extension");
  L.select("ext:pub.pack/night"); assert.equal(T.effectivePreset(), "ext:pub.pack/night");
  L.unregisterExtension("pub.pack");
  assert.equal(L.has("ext:pub.pack/night"), false);
  assert.notEqual(T.effectivePreset(), "ext:pub.pack/night", "removing the extension falls back");

  // ---- the editor's live preview: nothing stored.
  const before = store.get(T.STORE);
  const pr = L.preview({"atrium-theme":1, name:"Preview", type:"dark", extends:"fjord", colors:{accent:"#ff00aa"}});
  assert.equal(T.effectivePreset(), L.PREVIEW_ID); assert.equal(T.inlineTokens().accent, "#ff00aa"); assert.ok(pr.report);
  assert.equal(store.get(T.STORE), before, "preview does not persist");
  assert.ok(!L.list().some(x => x.id === L.PREVIEW_ID), "the preview is not listed");
  T.set({preset:"dark"});
  console.log("PASS theme library: schema, validation, derivation, " + L.BUILTIN_IDS.length + " built-in themes, cache, follow-OS, user and extension themes.");
})();
