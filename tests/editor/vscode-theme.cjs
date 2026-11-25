"use strict";
// VS Code import (app/editor/vscode-theme.js): JSONC parsing, workbench colours onto Waffle tokens with
// WCAG checks, the three built-in example themes, the optional syntax-colour canvas palette,
// .vsix reading (stored entries), and keybindings.json import with conflict reporting.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh vscode-theme).
const assert = require("node:assert/strict");
const store = new Map(), storage = {getItem:k => store.has(k) ? store.get(k) : null, setItem:(k, v) => store.set(k, String(v)), removeItem:k => store.delete(k)};
Object.defineProperty(globalThis, "localStorage", {value:storage, configurable:true, writable:true});
require("../../app/core/model.js");
require("../../app/editor/theme.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/editor/keymap.js");
require("../../app/editor/vscode-theme.js");
const V = AtriumVSCode, T = AtriumTheme, K = AtriumKeymap, c = T.color;
T.useStorage(storage); K.useStorage(storage);

// ---- JSONC ------------------------------------------------------------------------------------
{
  const j = V.parseJSONC('﻿{\n // line comment\n "a": "x // not a comment", /* block */ "b": [1, 2,],\n "c": "/* kept */", "d": {"e": "q\\"//",},\n}');
  assert.deepEqual(j, {a:"x // not a comment", b:[1, 2], c:"/* kept */", d:{e:'q"//'}});
  assert.deepEqual(V.parseJSONC("[1, /* c */ ]"), [1]);
  assert.deepEqual(V.parseJSONC('{"a":1, // trailing\n}'), {a:1});
  assert.throws(() => V.parseJSONC('{\n"a": 1\n"b": 2}'), /not valid JSON/);
}

// ---- the examples -----------------------------------------------------------------------------
assert.equal(V.EXAMPLES.length, 3);
const presets = [];
for (const ex of V.EXAMPLES) {
  const r = V.convert(ex.json, {canvas:true});
  presets.push(r.settings.preset);
  assert.equal(r.report.name, ex.name);
  assert.ok(T.validate({"atrium-theme":1, ...r.settings}).ok, ex.name + " is a valid Waffle theme");
  for (const k of T.TOKENS) assert.match(r.tokens[k], /^#[0-9a-f]{3,8}$/, ex.name + " --" + k);
  // Every text pair meets WCAG after mapping.
  for (const x of r.report.contrast) assert.ok(x.ratio >= x.min - .01, ex.name + ": " + x.token + " on " + x.on + " " + x.ratio + " < " + x.min);
  assert.ok(Object.keys(r.report.mapped).length >= 20, ex.name + " maps most workbench colours");
  // Canvas: copper distinguishable, legible on the board, darker than the selection white.
  const L = r.canvas.pcb.colors, board = r.canvas.pcb.system.board;
  assert.ok(V.deltaE(L.Top, L.Bottom) >= 40, ex.name + " top vs bottom copper");
  for (const [k, v] of Object.entries(L)) if (/^(Top|Bottom|Inner \d+)$/.test(k)) {
    assert.ok(c.contrast(v, board) >= 2.99, ex.name + " " + k + " on board");
    assert.ok(c.contrast(v, "#ffffff") >= 1.5, ex.name + " " + k + " vs selection");
  }
  assert.ok(Object.keys(L).filter(k => k.startsWith("Inner")).length >= 4, ex.name + " inner layers");
}
assert.deepEqual(presets, ["dark", "light", "hc"]);
// Imported tokens follow the theme: Ember Night's side bar and accent.
{
  const r = V.convert(V.EXAMPLES[0].json);
  assert.equal(r.tokens.panel, "#232120");
  assert.equal(r.report.mapped.accent, "activityBar.activeBorder");
  assert.equal(r.tokens["selection-ink"], "#fff3e6");
  assert.equal(r.canvas, undefined, "canvas palettes stay separate unless asked for");
  // Translucent list hover composited over the side bar.
  assert.equal(r.tokens.hover, c.over("#ffffff0f", "#232120"));
}

// ---- contrast warnings, fixes and derivation ------------------------------------------------------
{
  const bad = {name:"Murky", type:"dark", colors:{"editor.background":"#202020", "sideBar.background":"#202020", foreground:"#404040", "button.background":"#7a7a7a", "button.foreground":"#808080", "tab.inactiveForeground":"#333333"}};
  const r = V.convert(bad);
  assert.ok(r.report.warnings.some(w => /^foreground on sideBar.background is 1\.\d+:1/.test(w)), r.report.warnings.join("|"));
  assert.ok(r.report.warnings.some(w => /button\.foreground/.test(w)));
  assert.ok(c.contrast(r.tokens.ink, r.tokens.panel) >= 4.5);
  assert.ok(c.contrast(r.tokens["on-primary"], r.tokens.primary) >= 4.5);
  const keep = V.convert(bad, {fix:false});
  assert.equal(keep.tokens.ink, "#404040", "fix:false keeps the theme's colour");
  assert.ok(keep.report.warnings.length >= 2);
  // Minimal theme: almost everything derived, still legible; light type picks the light base.
  const min = V.convert({colors:{"editor.background":"#fdfdfd", "editor.foreground":"#999999"}});
  assert.equal(min.report.preset, "light");
  for (const x of min.report.contrast) assert.ok(x.ratio >= x.min - .01, "derived " + x.token + " on " + x.on);
  assert.throws(() => V.convert({name:"x"}), /no "colors"/);
  assert.equal(V.convert({type:"hcLight", colors:{"editor.background":"#ffffff"}}).report.preset, "light");
  // An include can't be followed from pasted text: a warning.
  assert.ok(V.convert({include:"./base.json", colors:{"editor.background":"#111111"}}).report.warnings.some(w => /includes/.test(w)));
}

// ---- apply --------------------------------------------------------------------------------------
{
  const r = V.applyTheme(V.EXAMPLES[1].json);
  const s = T.get();
  assert.equal(s.preset, "light"); assert.equal(s.name, "Paper Studio");
  assert.equal(T.tokensFor().panel, r.tokens.panel);
  assert.equal(AtriumPCBAppearance.color("Top"), "#ff0000", "layer colours untouched by default");
  V.applyTheme(V.EXAMPLES[0].json, {canvas:true});
  assert.notEqual(AtriumPCBAppearance.color("Top"), "#ff0000", "canvas option recolours copper");
  assert.ok(T.get().canvas.pcbBackground);
  AtriumPCBAppearance.reset(); T.reset();
  assert.ok(V.recent().length === 0, "examples are not listed as imported");
  V.applyTheme({name:"Mine", colors:{"editor.background":"#101820"}});
  assert.equal(V.recent()[0].name, "Mine");
  T.reset();
}

// ---- .vsix (zip with stored entries) ------------------------------------------------------------
{
  const enc = s => Array.from(new TextEncoder().encode(s));
  const files = [["extension/package.json", JSON.stringify({contributes:{themes:[{label:"Zip Dark", uiTheme:"vs-dark", path:"./themes/dark.json"}]}})],
    ["extension/themes/base.json", '{"colors": {"editor.background": "#123456", "sideBar.background": "#102030",}}'],
    ["extension/themes/dark.json", '// child\n{"include": "./base.json", "colors": {"sideBar.background": "#0e1a28"}}']];
  const bytes = [], central = [];
  const u16 = (a, v) => a.push(v & 255, v >> 8 & 255), u32 = (a, v) => { u16(a, v & 65535); u16(a, v >>> 16); };
  for (const [name, text] of files) {
    const n = enc(name), d = enc(text), off = bytes.length;
    u32(bytes, 0x04034b50); u16(bytes, 20); u16(bytes, 0); u16(bytes, 0); u16(bytes, 0); u16(bytes, 0); u32(bytes, 0); u32(bytes, d.length); u32(bytes, d.length); u16(bytes, n.length); u16(bytes, 0); bytes.push(...n, ...d);
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, d.length); u32(central, d.length);
    u16(central, n.length); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, off); central.push(...n);
  }
  const cdOff = bytes.length; bytes.push(...central);
  u32(bytes, 0x06054b50); u16(bytes, 0); u16(bytes, 0); u16(bytes, files.length); u16(bytes, files.length); u32(bytes, central.length); u32(bytes, cdOff); u16(bytes, 0);
  globalThis.__testDone = V.readVsix(new Uint8Array(bytes).buffer).then(out => {
    assert.equal(out.length, 1); assert.equal(out[0].label, "Zip Dark");
    assert.equal(out[0].json.colors["editor.background"], "#123456", "include merged");
    assert.equal(out[0].json.colors["sideBar.background"], "#0e1a28", "child wins");
    assert.equal(V.convert(out[0].json).report.preset, "dark");
  });
}

// ---- atrium-theme v1 documents (docs/themes.md)
{
  require("../../app/editor/theme-library.js");
  const Lib = globalThis.AtriumThemes;
  for (const ex of V.EXAMPLES) {
    const r = V.toDocument(ex.json, {canvas:true});
    const v = Lib.validate(r.doc);
    assert.ok(v.ok, ex.name + ": " + v.errors.join(" "));
    assert.ok(Object.keys(r.doc.colors).length >= T.TOKENS.length - 2, ex.name + " carries every token");
    assert.ok(r.doc.canvas.pcb.layers.Top && r.doc.canvas.pcb.system.board, ex.name + " canvas");
    assert.equal(r.doc.type, {dark:"dark", light:"light", hc:"hc-dark", hcLight:"hc-light"}[r.report.kind]);
  }
  assert.equal(V.toDocument({type:"hcLight", colors:{"editor.background":"#ffffff"}}).doc.type, "hc-light");
  const id = Lib.saveUser(V.toDocument(V.EXAMPLES[0].json).doc);
  assert.match(id, /^user:/); Lib.removeUser(id);
}

// ---- keybindings --------------------------------------------------------------------------------
{
  K.setPlatform(false);
  assert.equal(V.keyText("ctrl+shift+p", false), "Mod+Shift+P");
  assert.equal(V.keyText("cmd+k cmd+s", true), "Mod+K Mod+S");
  assert.equal(V.keyText("ctrl+k", true), "Ctrl+K");
  assert.equal(V.keyText("shift+alt+f12", false), "Shift+Alt+F12");
  assert.equal(V.keyText("ctrl+oem_comma", false), "Mod+,");
  assert.throws(() => V.keyText("hyper+x", false), /modifier/);
  const text = `[
    // mine
    { "key": "ctrl+shift+p", "command": "workbench.action.showCommands" },
    { "key": "ctrl+alt+9", "command": "workbench.action.files.save" },
    { "key": "ctrl+z", "command": "workbench.action.files.save" },
    { "key": "ctrl+alt+q", "command": "workbench.action.togglePanel", "when": "editorTextFocus" },
    { "key": "ctrl+alt+q", "command": "workbench.action.toggleSidebarVisibility" },
    { "key": "ctrl+y", "command": "-redo" },
    { "key": "ctrl+e", "command": "editor.action.formatDocument" },
    { "key": "ctrl+bogus", "command": "undo" },
  ]`;
  const plan = V.planKeybindings(text), by = cmd => plan.rows.filter(r => r.vscode === cmd);
  assert.equal(plan.mac, false);
  assert.equal(by("workbench.action.showCommands")[0].status, "same");
  assert.equal(by("workbench.action.files.save")[0].status, "ok");
  assert.equal(by("workbench.action.files.save")[1].status, "conflict", "Ctrl+Z is Undo");
  assert.match(by("workbench.action.files.save")[1].detail, /Undo/);
  assert.equal(by("workbench.action.togglePanel")[0].status, "ok");
  assert.equal(by("workbench.action.toggleSidebarVisibility")[0].status, "conflict", "the same key imported twice");
  assert.equal(by("-redo")[0].status, "remove");
  assert.equal(by("editor.action.formatDocument")[0].status, "unmapped");
  assert.equal(by("undo")[0].status, "invalid");
  const before = K.bindingsFor("redo").length;
  const res = V.applyKeybindings(plan, {skipConflicts:true});
  assert.ok(K.bindingsFor("save").some(b => b.key === K.normalize("Mod+Alt+9")));
  assert.ok(!K.bindingsFor("save").some(b => b.key === K.normalize("Mod+Z")), "conflicts skipped");
  assert.equal(K.bindingsFor("redo").length, before - 1, "-redo removed Ctrl+Y");
  assert.ok(K.bindingsFor("messages").some(b => b.key === K.normalize("Mod+Alt+Q")));
  assert.equal(res.conflicts.length, 0);
  const res2 = V.applyKeybindings(V.planKeybindings('[{"key":"ctrl+z","command":"workbench.action.files.save"}]'));
  assert.ok(res2.conflicts.length >= 1 && /Undo|Save/.test(res2.conflicts[0].message), "conflicts reported after applying");
  K.resetAll();
  assert.throws(() => V.planKeybindings('{"key":"x"}'), /list/);
}

