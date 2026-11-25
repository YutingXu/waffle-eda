"use strict";
// AtriumI18n (app/editor/i18n.js): define/t, ICU plurals and selects, Intl formatting, locale choice,
// English fallback; the extracted catalogues (app/locales/*.js); and AtriumI18nDOM's text
// matching (app/editor/i18n-dom.js) for the shell's menus, status bar and dialog buttons.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh i18n).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const app = path.join(__dirname, "../../app");
require("../../app/editor/i18n.js");
// The eager shim: English and {name} only, no catalogue.
{
  const S = AtriumI18n;
  const ts = S.define({"shim.hi": "Hi {name}", "shim.rows": "{count, plural, one {# row} other {# rows}}"});
  assert.equal(ts("shim.hi", {name: "Ada"}), "Hi Ada");
  assert.equal(S.t("shim.none"), "shim.none");
  assert.equal(S.t("shim.rows", {count: 2}), "{count, plural, one {# row} other {# rows}}", "plurals need the core");
  assert.equal(S.text("Ready", "status"), "Ready");
  assert.equal(S.locale(), "en");
  assert.equal(S.available, undefined, "the locale list lives in the core");
  assert.ok(fs.readFileSync(path.join(app, "editor/i18n.js")).length <= 1024, "the eager shim stays small");
}
require("../../app/editor/i18n-core.js");
const I = AtriumI18n;
assert.ok(I.core && I === AtriumI18nCore, "the core replaces the shim");
assert.equal(I.t("shim.hi", {name: "Bo"}), "Hi Bo", "and keeps its English");

// ---- English: define, params, plurals, selects ---------------------------------------------------------
assert.equal(I.locale(), "en", "English unless chosen");
const t = I.define({
  "test.hello": "Hello {name}",
  "test.rows": "{count, plural, =0 {No rows} one {# row} other {# rows}}",
  "test.nested": "{kind, select, pcb {{n, plural, one {# track} other {# tracks}}} other {{n, plural, one {# wire} other {# wires}}}}",
  "test.width": "Width {w, unit, mm}",
  "test.big": "{n, number} parts",
  "test.pct": "{p, number, percent} done",
  "test.plain": "Ready"
});
assert.equal(t("test.hello", {name: "Ada"}), "Hello Ada");
assert.equal(t("test.hello"), "Hello {name}", "a missing parameter stays visible");
assert.equal(t("test.rows", {count: 0}), "No rows");
assert.equal(t("test.rows", {count: 1}), "1 row");
assert.equal(t("test.rows", {count: 1234}), "1,234 rows", "# is formatted");
assert.equal(t("test.nested", {kind: "pcb", n: 2}), "2 tracks");
assert.equal(t("test.nested", {kind: "schematic", n: 1}), "1 wire");
assert.equal(t("test.width", {w: .25}), "Width 0.25 mm");
assert.equal(t("test.big", {n: 12345.5}), "12,345.5 parts");
assert.equal(t("test.pct", {p: .5}), "50% done");
assert.equal(t("test.plain"), "Ready");
assert.equal(t("test.unknown"), "test.unknown", "an unknown key shows the key");
assert.equal(I.define({"test.hello": "changed"})("test.hello", {name: "x"}), "Hello x", "the first definition wins");
assert.equal(I.unit(10, "mil"), "10 mil", "units Intl lacks");
assert.equal(I.number(1e6), "1,000,000");
assert.ok(/2026/.test(I.date(Date.UTC(2026, 10, 19, 12), "medium")), "date");
assert.ok(typeof I.ago(Date.now() - 5 * 60000) === "string");
assert.equal(I.text("Ready", "status"), "Ready", "no reverse lookup in English");
assert.throws(() => I.format("{a", {}), /unbalanced/);

// ---- locale choice ---------------------------------------------------------------------------------
const ids = I.available().map(l => l.id);
assert.deepEqual(ids.slice(0, 2), ["en", "en-XA"], "English first, then the pseudo-locale");
assert.equal(I.resolve("en-XA"), "en-XA");
assert.equal(I.resolve("xx-YY"), "en", "an unknown choice is English");
const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", {value: {languages: ["en-XA", "fr-CA"]}, configurable: true});
assert.equal(I.resolve("system"), "en", "System never picks the pseudo-locale");
Object.defineProperty(globalThis, "navigator", {value: {languages: ["en-GB"]}, configurable: true});
assert.equal(I.resolve("system"), "en", "en-GB -> en");
if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete globalThis.navigator;

// ---- catalogues -----------------------------------------------------------------------------------
const read = f => JSON.parse(fs.readFileSync(require("../support/app-source-paths.cjs").appFileFrom(app, "locales", f), "utf8"));
const en = read("en.json"), xa = read("en-XA.json"), keys = Object.keys(en).filter(k => k[0] !== "@");
assert.ok(keys.length > 900, "the shell is extracted: " + keys.length + " keys");
const boardStatus = ["status.region_split_assign_substacks_in_layer_stack_man", "status.set_the_board_perimeter_first"];
for (const k of ["menu.file", "menu.new_project_more", "cmd.new", "cmd.history-object", "status.ready",
  "common.cancel", "prefs.general", "start.blank_project", "prefs.language", ...boardStatus])
  assert.ok(k in en, "en.json has " + k);
assert.equal(en["menu.new_project_more"], "New Project…");
assert.deepEqual(Object.keys(xa).filter(k => k[0] !== "@").sort(), keys.slice().sort(), "the pseudo-locale has every key");
const placeholders = s => (s.match(/\{\s*\w+/g) || []).map(x => x.replace(/[{\s]/g, "")).sort().join();
for (const k of keys) {
  const e = en[k], x = xa[k];
  assert.ok(x.startsWith("[") && x.endsWith("]"), k + " is bracketed");
  assert.equal(placeholders(x), placeholders(e), k + " keeps its placeholders");
  if (e.length >= 12 && !e.includes("{")) assert.ok(x.length - 2 >= Math.floor(e.length * 1.3), k + " is about 35% longer");
}
// The generated loaders define the same messages.
require("../../app/locales/en.js"); require("../../app/locales/en-XA.js");
assert.equal(I.catalogue("en")["menu.file"], "File");
assert.equal(I.catalogue("en-XA")["menu.file"], xa["menu.file"]);

// ---- switching (headless: no document, the catalogue is already added) ----------------------------
(async () => {
  I.add("en-XA", {"test.rows": "[{count, plural, one {# ŕöŵ} other {# ŕöŵš}}]"});
  const seen = [];
  const off = I.onChange((id, was) => seen.push(was + ">" + id));
  assert.equal(await I.setLocale("en-XA"), "en-XA");
  assert.equal(I.locale(), "en-XA");
  assert.equal(t("test.rows", {count: 2}), "[2 ŕöŵš]");
  // Modules' plural()/count() helpers go through AtriumI18n.plural: the locale's message and rules.
  assert.equal(I.plural(1, "object"), xa["plural.object"].replace(/\{count, plural, one \{# ([^}]*)\} other \{# ([^}]*)\}\}/, "1 $1"));
  assert.match(I.plural(3, "object"), /^\[3 öƀĵéçţš/);
  assert.equal(I.plural(2, "unlisted word"), "2 unlisted words", "a word without a catalogue entry falls back to English");
  for (const k of Object.keys(en).filter(k => k.startsWith("plural."))) assert.match(en[k], /^\{count, plural, one \{# [^{}]+\} other \{# [^{}]+\}\}$/, k);
  assert.equal(t("test.hello", {name: "Ada"}), "Hello Ada", "a missing key falls back to English");
  assert.equal(I.t("menu.file"), xa["menu.file"]);

  // ---- AtriumI18nDOM text matching ------------------------------------------------------------------
  require("../../app/editor/i18n-dom.js");
  const D = AtriumI18nDOM;
  D.apply("en", "en-XA");
  assert.equal(D.translate("New Project…", ["menu"]), xa["menu.new_project_more"], "menu label");
  assert.equal(D.translate("  Ready ", ["status"]), "  " + xa["status.ready"] + " ", "surrounding space is kept");
  for (const key of boardStatus) assert.equal(D.translate(en[key], ["status"]), xa[key], key);
  assert.equal(D.translate("Cancel", ["prefs"]), xa["common.cancel"], "every scope has the common buttons");
  assert.equal(D.translate("Sensor board", ["shell"]), "Sensor board", "data is left alone");
  assert.equal(D.translate("12.5 mm", ["status"]), "12.5 mm");
  assert.equal(I.text("Ready", "status"), xa["status.ready"], "text() uses the DOM module's lookup");
  // Every menu item in index.html that is not data has a translation.
  const html = fs.readFileSync(path.join(app, "index.html"), "utf8");
  const menu = html.slice(html.indexOf('<nav class="menubar"'), html.indexOf("</nav>", html.indexOf('<nav class="menubar"')));
  const labels = [...menu.matchAll(/role="menuitem"(?![^>]*data-power-net)[^>]*>([^<]+)</g)].map(m => m[1].replace(/&amp;/g, "&").trim());
  assert.ok(labels.length > 200, "menu items: " + labels.length);
  for (const l of labels) assert.notEqual(D.translate(l, ["menu"]), l, "menu item " + l);
  // Back to English: translated text maps back to the source.
  assert.equal(await I.setLocale("en"), "en");
  assert.equal(I.plural(1, "object"), "1 object"); assert.equal(I.plural(1200, "box", "boxes"), "1,200 boxes");
  D.apply("en-XA", "en");
  assert.equal(D.translate(xa["menu.new_project_more"], ["menu"]), "New Project…");
  assert.equal(I.text("Ready", "status"), "Ready");
  assert.deepEqual(seen, ["en>en-XA", "en-XA>en"]);
  off();
  // Keymap command titles are extracted per id (cmd.<id>, cmd.<id>.<kind>, cmd.<id>.short).
  const km = fs.readFileSync(path.join(app, "editor/keymap.js"), "utf8");
  assert.ok(km.includes('["new","' + en["cmd.new"] + '"'), "cmd.new is the keymap title");
  assert.equal(en["cmd.route.pcb"], "Route track");
  console.log("i18n ok:", keys.length, "keys");
})().catch(e => { console.error(e); process.exitCode = 1; throw e; });
