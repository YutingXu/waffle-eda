"use strict";
// AtriumTheme: validation, import/export, accent derivation, canvas palettes, and the
// agreement between theme.js presets, style.css (Dark) and theme.css (other themes).
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
Object.defineProperty(globalThis,"localStorage",{value:storage,configurable:true,writable:true});
require("../../app/core/model.js");
require("../../app/editor/theme.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/schematic/sch-appearance.js");
const T=AtriumTheme,C=T.color,PCB=AtriumPCBAppearance,SCH=AtriumSchAppearance;
const app=path.join(__dirname,"../../app");
const read=f=>fs.readFileSync(require("../support/app-source-paths.cjs").appFileFrom(app, f),"utf8");

// Headless: no document, nothing applied, defaults loaded.
assert.equal(typeof globalThis.document,"undefined");
assert.deepEqual(T.get(),JSON.parse(JSON.stringify(T.DEFAULTS)));
assert.equal(T.effectivePreset(),"dark");
assert.deepEqual(T.inlineTokens(),{},"Dark with no accent sets no inline properties");
T.setSystemPreference(true);
assert.equal(T.effectivePreset(),"light","fresh preferences follow the system appearance");
T.setSystemPreference(false);

// Colour helpers.
assert.equal(C.normalize("#ABC"),"#aabbcc");
assert.equal(C.normalize("#12345"),null);
assert.equal(C.normalize("red"),null);
assert.equal(Math.round(C.contrast("#000","#fff")*100)/100,21);
assert.equal(C.mix("#000000","#ffffff",.5),"#808080");
assert.equal(C.over("#00000080","#ffffff"),"#7f7f7f");

// Dark tokens are byte-identical to style.css :root.
const css=read("style.css");
const rootBlock=css.slice(css.indexOf(":root {"),css.indexOf("}",css.indexOf(":root {")));
const rootTokens={};
for(const m of rootBlock.matchAll(/--([a-z0-9-]+):([^;]+);/g))rootTokens[m[1]]=m[2].trim();
for(const k of T.TOKENS)assert.equal(T.PRESETS.dark.tokens[k],rootTokens[k],"Dark --"+k+" matches style.css");

// theme.css carries every preset's tokens exactly.
const themeCss=read("theme.css");
for(const id of T.PRESET_IDS){
  const tokens=T.PRESETS[id].tokens;
  for(const k of T.TOKENS)assert.ok(k in tokens,id+" defines --"+k);
  if(id==="dark"){assert.ok(!themeCss.includes("[data-theme=dark]"),"Dark lives in style.css only");continue;}
  const start=themeCss.indexOf(":root[data-theme="+id+"] {"),block=themeCss.slice(start,themeCss.indexOf("}",start));
  assert.ok(start>=0,"theme.css has "+id);
  for(const k of [...T.TOKENS,...T.OPTIONAL])assert.ok(block.includes("--"+k+":"+tokens[k]+";")||block.includes("--"+k+":"+tokens[k]+"\n"),id+" --"+k+" in theme.css");
  const scoped=themeCss.slice(themeCss.indexOf(":root[data-theme="+id+"] :is("));
  for(const k of T.SCOPED)assert.ok(scoped.slice(0,scoped.indexOf("}")).includes("--"+k+":"+tokens[k]),id+" --"+k+" scoped");
  // Every non-dark token is a hex colour (import/export rule).
  for(const k of T.TOKENS)assert.match(tokens[k],/^#[0-9a-f]{3,8}$/,id+" --"+k+" is hex");
}
// Text tokens meet WCAG AA (4.5:1) on panels and the app background in the new themes.
for(const id of ["light","hc","classic"]){
  const t=T.PRESETS[id].tokens;
  for(const bg of ["panel","app","chrome","field"])for(const fg of ["ink","muted","faint"])
    assert.ok(C.contrast(t[fg],t[bg])>=4.5,id+" "+fg+" on "+bg+" "+C.contrast(t[fg],t[bg]).toFixed(2));
  assert.ok(C.contrast(t["selection-ink"],t.selection)>=4.5,id+" selection");
  assert.ok(C.contrast(t["on-primary"],t.primary)>=4.5,id+" primary");
  assert.ok(C.contrast(t.accent,t.panel)>=3,id+" accent on panel");
}

// Validation: known keys only, hex colours only.
assert.equal(T.validate({}).ok,true);
assert.equal(T.validate([]).ok,false);
assert.equal(T.validate({colour:"#fff"}).ok,false,"unknown key");
assert.equal(T.validate({accent:"orange"}).ok,false,"named colour");
assert.equal(T.validate({accent:"rgb(1,2,3)"}).ok,false,"rgb()");
assert.equal(T.validate({accent:"#3794FF"}).value.accent,"#3794ff");
assert.equal(T.validate({preset:"solarized"}).ok,false);
assert.equal(T.validate({fontSize:15}).ok,false);
assert.equal(T.validate({fontSize:"12"}).ok,false);
assert.equal(T.validate({density:"tight"}).ok,false);
assert.equal(T.validate({canvas:{follow:"yes"}}).ok,false);
assert.equal(T.validate({canvas:{bg:"#000000"}}).ok,false,"unknown canvas key");
assert.equal(T.validate({canvas:{schSheet:"#202020"}}).ok,false,"dark schematic sheet");
assert.equal(T.validate({tokens:{"--panel":"#ffffff"}}).ok,true);
assert.equal(T.validate({tokens:{"--evil":"#ffffff"}}).ok,false,"unknown token");
assert.equal(T.validate({tokens:{"--panel":"url(x)"}}).ok,false,"non-hex token");
assert.equal(T.validate({systemLight:"dark"}).ok,false);
assert.equal(T.validate({"atrium-theme":2}).ok,false);
const many=T.validate({preset:"x",accent:"y",zzz:1});
assert.equal(many.errors.length,3,"every problem is reported");

// Setting, persistence, events.
const seen=[];const off=T.onChange(d=>seen.push(d.reason));
T.set({preset:"light"});
assert.equal(T.effectivePreset(),"light");
assert.equal(JSON.parse(store.get(T.STORE)).preset,"light");
assert.deepEqual(seen,["change"]);
assert.throws(()=>T.set({accent:"blue"}));
assert.equal(T.get().accent,"","failed set leaves settings unchanged");
// Toggle switches family and remembers the last preset in each.
T.set({preset:"classic"});T.toggle();assert.equal(T.effectivePreset(),"dark");
T.toggle();assert.equal(T.effectivePreset(),"classic");
T.set({preset:"hc"});T.toggle();T.toggle();assert.equal(T.effectivePreset(),"hc");
// Follow system.
T.set({followSystem:true,systemLight:"light",systemDark:"hc"});
T.setSystemPreference(true);assert.equal(T.effectivePreset(),"light");
T.setSystemPreference(false);assert.equal(T.effectivePreset(),"hc");
T.set({preset:"dark"});assert.equal(T.get().followSystem,false,"choosing a preset stops following");
off();

// Primary buttons read white on blue (beta: "blue box with black text" in Dark): the Dark preset and every
// blue accent darken the fill until white ink reaches 4.5:1; only a light hue keeps dark ink.
assert.equal(T.PRESETS.dark.tokens["on-primary"],"#ffffff","Dark primary ink is white");
assert.ok(C.contrast("#ffffff",T.PRESETS.dark.tokens.primary)>=4.5,"Dark primary fill holds white ink");
for(const id of T.PRESET_IDS)for(const a of ["#0a84ff","#007aff","#3794ff","#005fbe"]){
  const d=T.derive(a,id);
  assert.equal(d.onPrimary,"#ffffff",id+" "+a+" primary ink");
  assert.ok(C.contrast(d.onPrimary,d.primary)>=4.5,id+" "+a+" primary contrast");
}
for(const id of T.PRESET_IDS)for(const a of [...T.ACCENTS.map(a=>a.hex),"#ffff00","#101010","#808080"]){
  const d=T.derive(a,id);
  assert.ok(C.contrast(d.onPrimary,d.primary)>=4.5,id+" "+a+" primary "+C.contrast(d.onPrimary,d.primary));
}
// Accent derivation keeps contrast in every theme.
for(const id of T.PRESET_IDS)for(const a of [...T.ACCENTS.map(a=>a.hex),"#ffff00","#101010","#808080"]){
  const d=T.derive(a,id),panel=T.PRESETS[id].tokens.panel;
  assert.ok(C.contrast(d.accent,panel)>=4.5,id+" "+a+" accent "+C.contrast(d.accent,panel));
  assert.ok(C.contrast(d.onAccent,d.accent)>=4.5,id+" "+a+" on-accent");
  assert.ok(C.contrast(d.selectionInk,d.selection)>=4.5,id+" "+a+" selection");
  assert.notEqual(d.hover,d.control);
}
assert.equal(T.derive("#f0a32e","dark").accent,"#f0a32e","a legible accent is kept");
assert.equal(T.derive("nope","dark"),null);
T.set({accent:"#3794ff"});
const inline=T.inlineTokens();
assert.deepEqual(Object.keys(inline).sort(),["accent","accent-btn-ink","accent-hover","accent-strong","accent-text","focus","on-accent","on-accent-2",
  "on-primary","primary","primary-line","sel-sub-ink","selection","selection-ink"]);

// System colour follows the same contrast policy as a user accent. Semantic and canvas tokens stay separate.
for (const preset of ["dark", "light"]) {
  const settings = {...T.DEFAULTS,preset,followSystem:false};
  const fallback = T.tokensFor(settings);
  if (preset === "dark") assert.equal(fallback.accent,"#0a84ff","the dark fallback retains exact system blue");
  assert.ok(C.contrast(fallback["accent-text"],fallback["panel-head"]) >= 4.5);
  if (preset === "dark") assert.equal(fallback["accent-text"],rootTokens["accent-text"],"prepaint accent text matches theme resolution");
  globalThis.__atriumHostAccent = "#a13d78";
  const system = T.tokensFor(settings);
  assert.equal(system.accent,T.derive("#a13d78",preset).control);
  assert.equal(system.primary,T.derive("#a13d78",preset).primary);
  assert.equal(system["on-primary"],"#ffffff","a primary button keeps white ink on a darkened fill");
  assert.ok(C.contrast(system.focus,system.raised)>=3);
  assert.ok(C.contrast(system["accent-text"],system["panel-head"])>=4.5);
  assert.ok(C.contrast("#ffffff",system["accent-strong"])>=3);
  assert.ok(C.contrast(system["on-primary"],system.primary)>=4.5);
  assert.ok(C.contrast(system["selection-ink"],system.selection)>=4.5);
  assert.equal(system.warning,fallback.warning);
  assert.equal(system["canvas-bg"],fallback["canvas-bg"]);
  assert.equal(T.tokensFor({...settings,accent:"#005fbe"}).accent,T.derive("#005fbe",preset).control);
  delete globalThis.__atriumHostAccent;
}

// Export → import round trip; import replaces (missing keys take defaults).
T.set({preset:"light",density:"compact",fontSize:14,motion:"reduce",canvas:{pcbBackground:"#101820",schSheet:"#ffffff"},tokens:{"--panel":"#fafafa"}});
const text=T.exportJSON(),data=JSON.parse(text);
assert.equal(data["atrium-theme"],1);
const before=T.get();T.reset();
assert.deepEqual(T.get(),JSON.parse(JSON.stringify(T.DEFAULTS)));
assert.equal(store.has(T.STORE),false,"defaults clear storage");
T.importJSON(text);
assert.deepEqual(T.get(),before);
assert.equal(T.inlineTokens().panel,"#fafafa");
T.importJSON('{"atrium-theme":1,"preset":"hc"}');
assert.equal(T.get().density,"default");
assert.throws(()=>T.importJSON("{nope"),/JSON/);
assert.throws(()=>T.importJSON('{"preset":"hc","script":"alert(1)"}'),/Unknown key/);
assert.equal(T.get().preset,"hc","a rejected import changes nothing");

// Stored settings load leniently: bad fields drop, good ones stay.
store.set(T.STORE,JSON.stringify({preset:"light",accent:"bogus",fontSize:13}));
T.useStorage(storage);
assert.equal(T.get().preset,"light");assert.equal(T.get().accent,"");assert.equal(T.get().fontSize,13);
assert.equal(T.get().followSystem,false,"a saved legacy preset remains an explicit choice");
store.set(T.STORE,"{garbage");T.useStorage(storage);assert.equal(T.get().preset,"dark");

// Canvas palettes reach the appearance modules.
T.reset();
assert.equal(PCB.system.workspace,PCB.defaultSystem.workspace,"Dark keeps the Altium PCB palette");
assert.equal(SCH.workspace,"#a3a3a3");assert.equal(SCH.paper,"#fffcf8");
const pcbEvents=[];const offPcb=PCB.onChange(k=>pcbEvents.push(k));
T.set({preset:"light"});
assert.equal(PCB.system.workspace,PCB.defaultSystem.workspace,"PCB stays dark in a light UI");
assert.equal(SCH.paper,"#ffffff","light UI → white sheet");
assert.deepEqual(pcbEvents,[],"no PCB event when nothing changed");
T.set({preset:"hc"});
assert.equal(PCB.system.workspace,"#000000");assert.deepEqual(pcbEvents,["theme"]);
T.set({canvas:{follow:false}});
assert.equal(PCB.system.workspace,PCB.defaultSystem.workspace,"standard palette when not following");
assert.equal(SCH.workspace,"#a3a3a3");
T.set({canvas:{follow:true,pcbBackground:"#f0f0f0",schBackground:"#202020"}});
assert.equal(PCB.system.workspace,"#f0f0f0");
assert.ok(C.luminance(PCB.system.workspaceGrid)<C.luminance("#f0f0f0"),"grid derives darker on a light workspace");
assert.equal(SCH.workspace,"#202020");
// A View Configuration override beats the theme, and reset returns to the theme.
PCB.setSystem("workspace","#123456");assert.equal(PCB.system.workspace,"#123456");
T.set({canvas:{pcbBackground:"#000000"}});assert.equal(PCB.system.workspace,"#123456");
assert.equal(PCB.isCustomSystem("workspace"),true);
PCB.reset();assert.equal(PCB.system.workspace,"#000000");assert.equal(PCB.isCustomSystem("workspace"),false);
PCB.setSystem("workspace","#000000");assert.equal(PCB.isCustomSystem("workspace"),false,"setting the theme value is not an override");
offPcb();
T.reset();
assert.equal(PCB.system.workspace,PCB.defaultSystem.workspace);
assert.equal(T.bootSnippet,undefined,"pre-paint is theme.js itself (load + applyRoot in <head>), which also reads the theme cache");
// Exercise the actual desktop callback as well as resolution from a supplied start-up accent.
{
  const native = globalThis;
  native.window = native.top = native;
  native.webkit = {messageHandlers:{atriumHost:{postMessage(){}}}};
  require("../../native/bridge.js");
  T.set({preset:"dark",accent:""});
  native.__waffleSystemAccent("#ffdb33");
  const system = T.tokensFor();
  assert.equal(system.accent,"#ffdb33","the warm system colour replaces the blue fallback");
  assert.ok(C.contrast("#ffffff",system["accent-strong"])>=3,"the toolbar glyph keeps contrast");
  T.set({accent:"#cc30cd"});
  const chosen = T.tokensFor().accent;
  native.__waffleSystemAccent("#3a9b66");
  assert.equal(T.tokensFor().accent,chosen,"an explicit accent survives host changes");
  T.set({accent:""});
  assert.equal(T.tokensFor().accent,"#3a9b66","clearing the explicit setting resumes following the host");
  native.__waffleSystemAccent(null);
  assert.equal(T.tokensFor().accent,"#0a84ff","the missing host colour restores the fallback");
}

// Theme Picker owns label translation. Theme Editor takes its own translator from that factory.
require("../../app/editor/theme-picker.js");
const pickerLabels = globalThis.AtriumThemePicker.labelTranslator;
const editorLabels = [];
globalThis.AtriumThemePicker = Object.assign({}, globalThis.AtriumThemePicker, {
  labelTranslator() { const t = pickerLabels(); editorLabels.push(t); return t; },
});
require("../../app/editor/theme-editor.js");
assert.equal(editorLabels.length, 1, "Theme Editor asks Theme Picker for one translator");
const pickerT = pickerLabels(), editorT = editorLabels[0];
assert.notEqual(pickerT, editorT, "each surface keeps its own translator");
for (const t of [pickerT, editorT]) {
  assert.equal(t("Saved {name}.", {name: "Ink"}), "Saved Ink.", "English fallback interpolation");
  assert.equal(t("themes.name_customised", {name: "Dark"}), "themes.name_customised", "missing catalogue returns the key");
}
globalThis.AtriumI18n = {
  catalogue(lang) {
    return lang === "en"
      ? {"themes.hex": "hex", "themes.name_customised": "{name} (customised)", "themes.same_a": "Same", "themes.same_b": "Same"}
      : {"themes.hex": "hex-fr", "themes.name_customised": "{name} (custom-fr)", "themes.same_a": "same-a-fr", "themes.same_b": "same-b-fr"};
  },
  define(obj) { throw new Error("define is not part of this control: " + JSON.stringify(obj)); },
  t(key, args) {
    const local = this.catalogue("fr"), english = this.catalogue("en");
    const template = Object.prototype.hasOwnProperty.call(local, key) ? local[key] : english[key];
    assert.notEqual(template, undefined, key);
    if (!args) return template;
    return template.replace(/\{(\w+)\}/g, (m, n) => Object.prototype.hasOwnProperty.call(args, n) ? args[n] : m);
  },
};
for (const t of [pickerT, editorT]) {
  assert.equal(t("themes.hex"), "hex-fr", "translated key");
  assert.equal(t("themes.name_customised", {name: "Dark"}), "Dark (custom-fr)", "translated interpolation");
  assert.equal(t("hex"), "hex-fr", "English catalogue string uses its extracted key");
  assert.equal(t("Same"), "same-a-fr", "first English catalogue string keeps the key");
}
const defined = [];
globalThis.AtriumI18n = {
  catalogue() { return {}; },
  define(obj) { defined.push(JSON.parse(JSON.stringify(obj))); },
  t(key) { return key; },
};
assert.equal(pickerT("Filter colours"), "themes.filter_colours");
assert.equal(pickerT("Filter colours"), "themes.filter_colours");
assert.equal(editorT("Filter colours"), "themes.filter_colours");
assert.deepEqual(defined, [
  {"themes.filter_colours": "Filter colours"},
  {"themes.filter_colours": "Filter colours"},
], "each surface defines a label once");
delete globalThis.AtriumI18n;

console.log("theme ok");
