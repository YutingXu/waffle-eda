"use strict";
// Persisted data other than projects (docs/format-versioning.md): files and
// stores written by earlier versions load in this one, and data from a newer version is refused
// with a clear message or left untouched, never silently overwritten. Fixtures:
// tests/fixtures/compat/stores/ (never edited; add files for new versions).
// Covered elsewhere: autosave and the legacy workspace key (tests/project/autosave.cjs), the save journal
// and recovery sidecar (native/tests/project_journal.py), ECO files v1 and v2 (tests/schematic/eco.cjs),
// MCP proposals v1 and v2 (tests/automation/mcp.py), projects (tests/formats/compat.cjs, tests/formats/compat-corpus.cjs).
// Run: scripts/test-jsc.sh compat-stores   (or node tests/formats/compat-stores.cjs)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const DIR = path.join(__dirname, "../fixtures/compat/stores"), APP = path.join(__dirname, "../../app");
const fixture = name => fs.readFileSync(path.join(DIR, name), "utf8");
// Values from another context compared as data (their prototypes differ).
const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; }, map: m};
}
// Each module runs in its own context with its own storage, as it would in a fresh profile.
function load(files, extra = {}) {
  const ctx = vm.createContext({console, setTimeout: () => 0, clearTimeout: () => {}, ...extra});
  for (const f of files) vm.runInContext(fs.readFileSync(require("../support/app-source-paths.cjs").appFileFrom(APP, f), "utf8"), ctx);
  return ctx;
}

// ---- preferences: Preferences › Export (atrium-prefs 1) --------------------------------------------
{
  const local = storage(), {AtriumPrefs: P} = load(["theme.js", "prefs.js"], {localStorage: local});
  const r = P.importJSON(fixture("prefs-v1.atrium-prefs.json"));
  same(r.skipped, []);
  assert.equal(P.get("general.units"), "mil"); assert.equal(P.get("pcb.grid"), 0.127); assert.equal(P.get("pcb.hud"), true);
  same(P.get("custom.module.key"), {kept: true}, "keys other modules own are kept as given");
  assert.equal(JSON.parse(local.getItem(P.STORE)).version, P.VERSION);
  const newer = JSON.parse(fixture("prefs-v1.atrium-prefs.json")); newer.version = P.VERSION + 1;
  assert.throws(() => P.importJSON(newer), /newer Waffle/);
}

// ---- preferences a newer build stored: a choice this build doesn't know is not used, and is kept --------
{
  const stored = {format: "atrium-prefs", version: 1, values: {"general.units": "um", "pcb.grid": 0.5, "future.flag": true}};
  const local = storage({"atrium.prefs": JSON.stringify(stored)}), {AtriumPrefs: P} = load(["theme.js", "prefs.js"], {localStorage: local});
  assert.equal(P.get("general.units"), "mm", "an unknown choice falls back to the default");
  P.set("pcb.grid", 0.127);
  same(JSON.parse(local.getItem("atrium.prefs")).values, {"general.units": "um", "pcb.grid": 0.127, "future.flag": true}, "saving another key keeps it unchanged");
  P.set("general.units", "mil");
  assert.equal(JSON.parse(local.getItem("atrium.prefs")).values["general.units"], "mil", "until this build sets that key");
}

// ---- settings bundle: File › Export Settings… (atrium-settings 1), and a newer one ------------------------
{
  const local = storage(), ctx = load(["theme.js", "keymap.js", "prefs.js"], {localStorage: local}), P = ctx.AtriumPrefs;
  const r = P.importSettings(fixture("settings-v1.atrium-settings.json"));
  assert.ok(r.applied.includes("preferences") && r.applied.includes("appearance") && r.applied.includes("key map"), JSON.stringify(r));
  assert.equal(P.get("general.units"), "mil"); assert.equal(P.get("pcb.smartGuides"), false);
  assert.equal(P.get("workbench.layouts")[0].name, "Mine", "saved layouts travel as preferences");
  assert.equal(ctx.AtriumTheme.get().preset, "dark");
  same(ctx.AtriumKeymap.bindingsFor("save").map(b => b.key), ["Mod+Shift+S"]);
  // A preferences-only file (from older versions) imports through the settings importer too.
  same(P.importSettings(fixture("prefs-v1.atrium-prefs.json")).applied, ["preferences"]);
  const before = P.get("general.units");
  assert.throws(() => P.importSettings(fixture("settings-v2-newer.atrium-settings.json")), /newer Waffle/);
  assert.equal(P.get("general.units"), before, "nothing applied from a newer file");
}

// ---- key maps: *.waffle-keys version 1, and an older file with no format or version -----------------------
{
  const {AtriumKeymap: K} = load(["keymap.js"], {localStorage: storage()});
  same(K.importJSON(fixture("keymap-v1.atrium-keys")), []);
  const out = JSON.parse(K.exportJSON());
  assert.equal(out.format, "atrium-keys"); assert.equal(out.version, 1);
  same(out.bindings.save.map(b => b.key ?? b), ["Mod+S"]);
  same(K.importJSON(fixture("keymap-unversioned.atrium-keys")), [], "an unversioned key map is read as version 1");
  assert.throws(() => K.importJSON({format: "something-else"}), /not a Waffle key map/);
}

// A rejected binding must leave the preset in effect across import and reload.
{
  const local = storage(), state = {kind: "schematic", canvas: true, tool: "select"};
  const fresh = () => load(["keymap.js"], {localStorage: local}).AtriumKeymap;
  const keymap = fresh(), importKeys = save => keymap.importJSON({format: "atrium-keys", version: 1, bindings: {save}});
  const stored = () => JSON.parse(local.getItem("atrium-keymap-v1")).bindings;
  same(importKeys(["Ctrl+NotAKey"]), ["save: Unknown key “NotAKey”."]);
  assert.equal(Object.hasOwn(stored(), "save"), false, "invalid-only import omits the override");
  assert.equal(fresh().resolve("Mod+S", state), "save");

  same(importKeys([{key: "Mod+Alt+F10 K", when: "schematic"}, {key: "Mod+S", when: "schematic &&"}]),
    ["save: Context “schematic &&” ends early."]);
  same(stored().save, [{key: "Mod+Alt+F10 K", when: "schematic"}]);
  const mixed = fresh();
  assert.equal(mixed.resolve("Mod+Alt+F10 K", state), "save");
  assert.equal(mixed.resolve("Mod+Alt+F10 K", {...state, kind: "pcb"}), null);
  assert.equal(mixed.resolve("Mod+S", state), null);

  same(importKeys([]), []);
  same(stored().save, []);
  assert.equal(fresh().resolve("Mod+S", state), null, "explicit unbind survives reload");
}

// ---- themes: atrium-theme 1, an older file without the format key, and a newer format ----------------------
{
  const {AtriumTheme: T} = load(["theme.js"], {localStorage: storage()});
  assert.equal(T.validate(JSON.parse(fixture("theme-v1.atrium-theme.json"))).ok, true);
  assert.equal(T.validate(JSON.parse(fixture("theme-unversioned.json"))).ok, true, "a theme with no format key is version 1");
  const newer = T.validate({...JSON.parse(fixture("theme-v1.atrium-theme.json")), "atrium-theme": 2});
  assert.equal(newer.ok, false); assert.match(newer.errors.join(" "), /Unsupported theme format 2/);
}

// ---- workspace layouts (prefs workbench.layout): version 1, and an older shape without "v" -----------------
{
  const {AtriumDock: D} = load(["dock.js"]);
  const v1 = D.normalize(JSON.parse(fixture("layout-v1.json")));
  assert.equal(v1.v, 1); assert.equal(v1.name, "Mine");
  const old = D.normalize(JSON.parse(fixture("layout-unversioned.json")));
  assert.equal(old.v, 1, "an unversioned layout is upgraded to version 1"); assert.equal(old.name, "Old");
}

// ---- clipboard history: localStorage atrium.clipboard.v1 --------------------------------------------------------
{
  // The key carries the version, so a newer Waffle's history (another key) is never overwritten.
  const local = storage({"atrium.clipboard.v1": fixture("clip-history-v1.json"), "atrium.clipboard.v2": "{\"from\":\"a newer Waffle\"}"});
  const {webcrypto} = require("node:crypto");
  const ctx = load(["uuid-v7.js", "model.js", "parts.js", "edit-selection.js", "selection-clipboard.js", "clip-history.js"],
    {localStorage: local, document: {querySelector: () => null, addEventListener: () => {}}, window: {getSelection: () => ""}, crypto: webcrypto, __waffleUUIDSeed:globalThis.__waffleUUIDSeed, structuredClone, navigator: {}});
  const H = ctx.AtriumClipHistory;
  assert.equal(H.restore(), 1, "a pinned version 1 entry is restored");
  assert.equal(H.list()[0].id, "c1");
  H.save();
  assert.equal(JSON.parse(local.getItem("atrium.clipboard.v1")).version, 1);
  assert.equal(local.getItem("atrium.clipboard.v2"), "{\"from\":\"a newer Waffle\"}", "another version's store is untouched");
}

// ---- extension manifests: apiVersion 1 still loads; an unknown apiVersion is refused by name ------------------
{
  for (const f of ["model", "parts", "spatial", "altium-rules", "rules", "connectivity", "zip", "keymap", "proposal", "atrium-api", "extension-host-worker", "extensions"])
    require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
  const X = AtriumExtensions, m = JSON.parse(fixture("extension-manifest-api1.json"));
  assert.equal(AtriumAPI.VERSION, 1, "this build provides extension API 1 (update docs/upgrading.md when it changes)");
  assert.equal(X.validateManifest(m, {"main.js": ""}), m);
  assert.throws(() => X.validateManifest({...m, apiVersion: 2}, {"main.js": ""}), /apiVersion 2 is not supported \(this editor provides 1\)/);
}

// The v1 fixture was written by the original folder reader for the matching KiCad footprint.
for (const f of ["model", "parts", "library-store", "library-panel", "board-shape", "sexpr", "import-kicad", "library-import-kicad", "catalogue", "library-sources"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
globalThis.__testDone = (async () => {
  const S = AtriumLibrarySources, old = JSON.parse(fixture("library-folder-index-v1.json")), [file] = Object.keys(old.files);
  const folder = {id: "legacy-library", name: "Test library"};
  const offline = await S.refresh(folder, null, {index: old});
  assert.equal(offline.library.defs[0].name, "TestPad_Test");
  assert.ok(offline.library.defs[0].stub);
  assert.equal(offline.index.version, 1);
  const data = fs.readFileSync(path.join(__dirname, "../fixtures/kicad", file), "utf8");
  const provider = S.providers.memory(new Map([[file, {data, mtime: old.files[file].mtime}]]));
  const migrated = await S.refresh(folder, provider, {index: offline.index});
  assert.equal(migrated.index.version, 3);
  assert.equal(migrated.stats.read, 1);
  assert.equal(migrated.index.files[file].sha256, old.files[file].sha256);
  assert.equal(migrated.library.defs[0].id, offline.library.defs[0].id);
  assert.equal((await S.refresh(folder, provider, {index: migrated.index})).stats.read, 0);
  const older = await S.refresh(folder, provider, {index: {...migrated.index, version: 2}});
  assert.equal(older.index.version, 3);
  assert.equal(older.stats.read, 1);
  await assert.rejects(S.refresh(folder, provider, {index: {...old, version: 4}}), /newer version/);
})().catch(e => { console.error(e); process.exitCode = 1; });

// Independent stores keep their own parsers, including files with a historical branding suffix.
{
  require("../../app/project/obsolete-project.js");
  for (const name of ["prefs-v1.atrium-prefs.json","settings-v1.atrium-settings.json","keymap-v1.atrium-keys",
    "theme-v1.atrium-theme.json","layout-v1.json","clip-history-v1.json","extension-manifest-api1.json","library-folder-index-v1.json"]) {
    assert.equal(AtriumObsoleteProject.recognize(fixture(name),name),false,name);
  }
}
