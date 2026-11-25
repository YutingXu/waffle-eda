"use strict";
// Adversarial proofs of concept for extension developer mode and its neighbours
//. Runs in the extension sandbox harness:
//   scripts/test-jsc.sh security-extdev        or      node tests/extensions/security-extdev.cjs
//
// The fixed* checks were proofs of concept for F6-F9; they now assert the safe behaviour and guard
// against regressions. ok* checks guard what held up in the review.
const harness = require("../../extensions/examples/harness.cjs");
const ROOT = __dirname + "/../../";

const manifest = (id, name, perms, extra = {}) => ({id, name, version: "1.0.0", apiVersion: 1, main: "main.js",
  activationEvents: ["onCommand:" + id + ".run"], permissions: perms, contributes: {commands: [{command: id + ".run", title: name}]}, ...extra});
const pkg = (m, main) => ({"waffle-extension.json": JSON.stringify(m), "main.js": main});

// F7 (Low): Messages rows from an extension carry Source = the extension's self-chosen name, which
// is the only column that names the producer. A name equal to a built-in source ("rules", "Import",
// "SI", ...) makes its Error rows indistinguishable from the editor's own in the panel and in the
// exported report; the "(extension)" suffix lives only in the hidden group key.
async function fixedMessagesSourceSpoof(h) {
  const {assert, X} = h;
  const id = "spoof.rules";
  await X.install(pkg(manifest(id, "rules", ["ui:command"]),
    `exports.activate = api => api.commands.register("${id}.run", () => api.ui.showMessage("Design rule check finished", {messages: [
      {class: "Error", text: "Clearance Constraint: (0.05mm < 0.2mm) Between Track on Top and Pad U1-3", objectId: "abc"}]}));`));
  await X.execute(id + ".run");
  assert.equal(h.reported("rules (extension)").length, 0, "a built-in source name is never used as the group");
  const rows = h.reported("spoof.rules (extension)");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "spoof.rules (extension)", "a reserved name shows the extension id, marked (extension), in the visible Source");
  assert.ok(globalThis.AtriumMessages.toCSV(rows).includes("spoof.rules (extension)"), "the marker is kept in exports");
  assert.ok(!h.reported().some(m => m.source === "rules" && m.text.startsWith("Clearance Constraint")), "nothing reads exactly like the built-in rule checks");
  await X.uninstall(id);
  // An ordinary name is shown with the marker too.
  await X.install(pkg(manifest("plain.check", "Teardrop Audit", ["ui:command"]),
    `exports.activate = api => api.commands.register("plain.check.run", () => api.ui.showMessage("x", {messages: [{class: "Warning", text: "w"}]}));`));
  await X.execute("plain.check.run");
  assert.equal(h.reported("Teardrop Audit (extension)")[0].source, "Teardrop Audit (extension)");
  await X.uninstall("plain.check");
}

// F6 (Medium): grants are keyed id@sha256 for project and dev loads, but api.storage (and settings)
// are keyed by id alone. A different bundle with the same id - another person's project, or an
// unpacked folder - inherits everything an earlier extension of that id stored (tokens, keys).
async function fixedStorageFollowsTheBundle(h) {
  const {assert, X} = h;
  const id = "acme.supplier";
  const writer = pkg(manifest(id, "Supplier lookup", ["ui:command"]),
    `exports.activate = api => api.commands.register("${id}.run", async () => { await api.storage.set("apiKey", "sk-live-SECRET"); return "stored"; });`);
  const reader = pkg(manifest(id, "Supplier lookup", ["ui:command"]),
    `exports.activate = api => api.commands.register("${id}.run", async () => api.storage.get("apiKey"));`);
  const bundle = files => ({manifest: JSON.parse(files["waffle-extension.json"]), files: {"main.js": files["main.js"]}});
  const original = h.project;
  // Project A (a colleague's) ships the honest extension; the user trusts it and it stores a key.
  h.project = {...JSON.parse(JSON.stringify(original)), extensions: [bundle(writer)]};
  X.notify("documentChanged");
  await X.trust(id);
  assert.equal(await X.execute(id + ".run"), "stored");
  X.stopAll("switch project");
  await h.wait(150); // storage flushes after 100 ms
  // Project B (a stranger's) ships different code under the same id. Trusting it shows the same
  // name and permissions; the grant is new (id@sha256 differs) but the storage is not.
  h.project = {...JSON.parse(JSON.stringify(original)), extensions: [bundle(reader)]};
  X.notify("documentChanged");
  const row = X.list().find(e => e.id === id);
  assert.equal(row.origin, "project");
  await X.trust(id);
  assert.equal(await X.execute(id + ".run"), null, "another bundle with the same id cannot read the first one's storage");
  X.stopAll("switch project");
  // The same holds for an unpacked folder in developer mode once that project is closed.
  h.project = JSON.parse(JSON.stringify(original));
  X.notify("documentChanged");
  h.developerMode = true;
  await X.installDev(reader);
  assert.equal(await X.execute(id + ".run"), null, "an unpacked load cannot read it either");
  // An unpacked load's own storage lasts for the session only and is cleared on unload.
  await X.installDev(writer);
  assert.equal(await X.execute(id + ".run"), "stored");
  await X.installDev(reader); // a reload with the same permissions keeps this session's storage
  assert.equal(await X.execute(id + ".run"), "sk-live-SECRET", "reloading the same folder keeps its session storage");
  await X.unloadDev(id);
  await X.installDev(reader);
  assert.equal(await X.execute(id + ".run"), null, "unload cleared it");
  await X.unloadDev(id);
  // Reopening project A (the bundle the user trusted) still finds its own data.
  h.project = {...JSON.parse(JSON.stringify(original)), extensions: [bundle(writer)]};
  X.notify("documentChanged");
  assert.equal(X.list().find(e => e.id === id).status, "inactive", "A is still trusted");
  h.developerMode = false;
  h.project = original;
  X.notify("documentChanged");
}

// F9 (Info): a dev load and a project bundle with the same files share one grant key (id@sha256);
// unloading the dev copy deletes the project's grant, and a dev grant left behind when Waffle quits
// (unloadDev never runs) stays in localStorage although the code is "forgotten".
async function fixedDevAndProjectGrantKeysAreSeparate(h) {
  const {assert, X} = h;
  const id = "acme.shared";
  const files = pkg(manifest(id, "Shared", ["ui:command", "read:project"]),
    `exports.activate = api => api.commands.register("${id}.run", () => 1);`);
  const original = h.project;
  h.project = {...JSON.parse(JSON.stringify(original)), extensions: [{manifest: JSON.parse(files["waffle-extension.json"]), files: {"main.js": files["main.js"]}}]};
  X.notify("documentChanged");
  await X.trust(id);
  const projectHash = X.list().find(e => e.id === id);
  assert.ok(projectHash);
  const declaredBefore = X.permissions(id).live;
  assert.equal(declaredBefore["read:project"], true);
  h.project = JSON.parse(JSON.stringify(original)); X.notify("documentChanged");
  h.developerMode = true;
  const e = await X.installDev(files);
  await X.unloadDev(id);
  h.developerMode = false;
  // Reopen project A: still trusted, but its grant went with the dev unload, so it asks again.
  h.project = {...JSON.parse(JSON.stringify(original)), extensions: [{manifest: JSON.parse(files["waffle-extension.json"]), files: {"main.js": files["main.js"]}}]};
  X.notify("documentChanged");
  assert.equal(X.list().find(x => x.id === id).status !== "blocked", true, "still trusted");
  assert.equal(X.permissions(id).live["read:project"], true, "unloading the dev copy leaves the project's grant alone (" + e.hash.slice(0, 20) + ")");
  h.project = original; X.notify("documentChanged");
}

// F8 (Low): Import settings applies any preference key, including the two security switches
// extensions.developerMode and general.updateCheck, without naming them. A shared "settings bundle"
// silently turns on update checks (requests to github.com) and developer mode.
async function fixedSettingsImportHoldsSecuritySwitches(h) {
  const {assert} = h;
  require(ROOT + "app/editor/prefs.js");
  const P = globalThis.AtriumPrefs;
  assert.equal(P.get("extensions.developerMode") === true, false);
  assert.equal(P.get("general.updateCheck") === true, false, "update checks are off by default");
  const r = P.importJSON({format: "atrium-prefs", version: 1, values: {"pcb.grid": 1, "extensions.developerMode": true, "general.updateCheck": true}});
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.held.sort(), ["extensions.developerMode", "general.updateCheck"], "both switches are held for the user to confirm");
  assert.equal(P.get("pcb.grid"), 1, "ordinary preferences still import");
  assert.notEqual(P.get("extensions.developerMode"), true, "developer mode stays off");
  assert.notEqual(P.get("general.updateCheck"), true, "update checks stay off");
  // Explicitly ticked switches apply.
  const t = P.importJSON({format: "atrium-prefs", version: 1, values: {"extensions.developerMode": true}}, {allow: ["extensions.developerMode"]});
  assert.deepEqual(t.held, []); assert.equal(P.get("extensions.developerMode"), true);
  // Turning a switch off is never held.
  const off = P.importJSON({format: "atrium-prefs", version: 1, values: {"extensions.developerMode": false}});
  assert.deepEqual(off.held, []); assert.notEqual(P.get("extensions.developerMode"), true);
  assert.deepEqual(Object.keys(P.GUARDED).sort(), ["extensions.developerMode", "general.updateCheck"]);
  P.reset(["pcb.grid", "extensions.developerMode", "general.updateCheck"]);
}

// Guards: what held up.
async function okDevGuards(h) {
  const {assert, X} = h;
  h.developerMode = false;
  await assert.rejects(X.installDev(pkg(manifest("g.one", "G", ["ui:command"]), "")), /Developer mode is off/);
  h.developerMode = true;
  // Cannot take a built-in, installed or project id; a manifest id with '@' cannot forge a grant key.
  await assert.rejects(X.installDev(pkg(manifest("waffle.calculators", "C", ["ui:command"]), "")), /built into Waffle/);
  assert.throws(() => X.validateManifest(manifest("a.b@sha256:00", "x", []), {"main.js": ""}), /id must look like/);
  // Every fresh load prompts even if a grant for the same id@sha256 already exists.
  const files = pkg(manifest("g.two", "G", ["ui:command"]), `exports.activate = api => api.commands.register("g.two.run", () => 2);`);
  await X.installDev(files); await X.unloadDev("g.two");
  h.prompts.length = 0;
  await X.installDev(files);
  assert.deepEqual(h.prompts, ["install:g.two"]);
  // The console runner and extension realms see no host bridge.
  const r = await X.runScript("return [typeof AtriumHost, typeof webkit, typeof chrome, typeof document, typeof fetch]");
  assert.equal(r.ok, true, r.error && r.error.message);
  assert.deepEqual(r.value, ["undefined", "undefined", "undefined", "undefined", "undefined"]);
  await X.unloadDev("g.two");
  h.developerMode = false;
}

// The update check: with the shipped empty key nothing is fetched or trusted.
async function okUpdateCheckWithEmptyKey(h) {
  const {assert} = h;
  require(ROOT + "app/editor/update-check.js");
  const U = globalThis.AtriumUpdate;
  assert.equal(U.PUBLIC_KEY, "");
  let fetched = 0;
  const r = await U.check({fetch: async () => { fetched++; throw Error("no network"); }});
  assert.equal(r.status, "unavailable"); assert.equal(fetched, 0, "no request without a key");
  const s = await U.startup({force: true, storage: {getItem: () => null, setItem() {}}, enabled: true, fetch: async () => { fetched++; return {ok: false}; }, showWhatsNew() {}});
  assert.equal(fetched, 0); assert.equal(s.result.status, "unavailable");
  const off = await U.startup({force: true, storage: {getItem: () => null, setItem() {}}, fetch: async () => { fetched++; return {ok: false}; }, showWhatsNew() {}});
  assert.equal(off.checked, false, "off by default"); assert.equal(fetched, 0);
  // Edge keys are refused rather than trusted.
  for (const key of ["0".repeat(64), "01" + "0".repeat(62), "ec" + "f".repeat(60) + "7f", "x".repeat(64)])
    assert.equal(U.verify(new Uint8Array([1]), new Uint8Array(64), key), false, key);
}

harness.run([
  [fixedMessagesSourceSpoof, null, "F7 Messages Source marked (extension), reserved names (fixed)"],
  [fixedStorageFollowsTheBundle, null, "F6 storage follows the trusted bundle (fixed)"],
  [fixedDevAndProjectGrantKeysAreSeparate, null, "F9 dev and project grant keys separate (fixed)"],
  [fixedSettingsImportHoldsSecuritySwitches, null, "F8 settings import holds security switches (fixed)"],
  [okDevGuards, null, "developer-mode guards (ok)"],
  [okUpdateCheckWithEmptyKey, null, "update check with empty key (ok)"]
]);
