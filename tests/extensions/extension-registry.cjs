"use strict";
// Browse Extensions (app/extension-host/extension-registry.js), security behaviour:
//  - no request of any kind until the user configures a registry URL (or opens an index file);
//  - a package whose bytes do not match the index's SHA-256 is rejected before it is parsed,
//    and nothing is installed or prompted;
//  - a package that asks for other permissions, or is another id/version, is rejected;
//  - a genuine package installs only through AtriumExtensions.install's permission prompt;
//  - index and download URLs must be https (http only to localhost), without credentials.
const assert = require("node:assert/strict");
require("../../app/core/model.js"); require("../../app/library/parts.js"); require("../../app/core/spatial.js"); require("../../app/checks/altium-rules.js");
require("../../app/checks/rules.js"); require("../../app/checks/connectivity.js"); require("../../app/core/zip.js"); require("../../app/editor/keymap.js"); require("../../app/automation/proposal.js");
require("../../app/core/atrium-api.js"); require("../../app/workers/extension-host-worker.js"); require("../../app/extension-host/extensions.js"); require("../../app/automation/scripting.js");
require("../../app/extensions/manifests.js");

// Every request anyone makes is recorded; the registry must make none until configured.
const requests = [];
let routes = {};
const fakeFetch = async (url, init) => {
  requests.push({url, init});
  const body = routes[url];
  if (body == null) return {ok: false, status: 404, headers: {get: () => null}, arrayBuffer: async () => new ArrayBuffer(0)};
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {ok: true, status: 200, headers: {get: k => (k.toLowerCase() === "content-length" ? String(bytes.length) : null)}, arrayBuffer: async () => bytes.slice().buffer};
};
globalThis.fetch = fakeFetch; // even the default fetch path is observed
require("../../app/extension-host/extension-registry.js");
const R = AtriumExtensionRegistry, X = AtriumExtensions;
assert.equal(requests.length, 0, "loading the module makes no request");

// An editor-like host and a consent stub (see tests/extensions/extensions.cjs).
const project = AtriumParts.example();
const host = {project: () => project, documentId: () => project.documents[0].id, revision: () => 0, selection: () => new Set(), select() {},
  edit(fn) { fn(); }, amend(fn) { fn(); }, info() {}, activate() {}, runAction() {}, exportFile: () => true, locate() {}};
const prompts = [];
let answer = r => Object.fromEntries(r.permissions.map(p => [p, true]));
let workers = 0;
X.attach(host, {consent: r => { prompts.push(r.kind + ":" + r.manifest.id + ":" + r.permissions.join(",")); return answer(r); },
  createWorker: () => { workers++; throw Error("no extension code may run in this test"); }, fetch: fakeFetch, heartbeatMs: 100});

const store = new Map();
R.configure({fetch: fakeFetch, extensions: X, document: () => null,
  storage: {get: (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d), set: (k, v) => store.set(k, JSON.stringify(v))}});

const manifest = {id: "test.hello", name: "Hello", publisher: "Test", version: "1.2.0", apiVersion: 1, main: "main.js",
  activationEvents: ["onCommand:hello.run"], permissions: ["read:project", "ui:command"],
  contributes: {commands: [{command: "hello.run", title: "Hello"}]}};
const bundle = (m = manifest, main = "exports.activate = api => api.commands.register('hello.run', () => 1);") =>
  new TextEncoder().encode(JSON.stringify({manifest: m, files: {"main.js": main}}));
const genuine = bundle(), digest = R.sha256(genuine);
const INDEX_URL = "https://registry.example/atrium/index.json", PKG_URL = "https://registry.example/atrium/pkg/test.hello-1.2.0.waffle-extension";
const entry = (o = {}) => ({id: "test.hello", name: "Hello", publisher: "Test", version: "1.2.0", apiVersion: 1, permissions: ["read:project", "ui:command"],
  sha256: digest, download: "pkg/test.hello-1.2.0.waffle-extension", source: "https://git.example/test/hello", license: "MIT", signature: null, ...o});
const index = (entries = [entry()]) => JSON.stringify({format: "atrium-extension-index", version: 1, name: "Test registry", extensions: entries});

globalThis.__testDone = (async () => {
  // ------------------------------------------------------------- SHA-256 of raw bytes
  assert.equal(R.sha256(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(R.sha256(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const long = new Uint8Array(1000003); for (let i = 0; i < long.length; i++) long[i] = i * 31 & 255;
  assert.equal(R.sha256(long).length, 64);

  // ------------------------------------------------- off by default: no request at all
  assert.equal(R.enabled(), false);
  assert.deepEqual(R.config(), {url: ""});
  assert.deepEqual(await R.refresh(), {configured: false, index: null});
  assert.equal(R.open(), null, "no document: nothing opens");
  await assert.rejects(R.install(entry({download: PKG_URL})), /Load an extension index first/);
  assert.equal(requests.length, 0, "no fetch happens without a configured registry URL");

  // ------------------------------------------------------------------ URL rules
  for (const bad of ["http://registry.example/i.json", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@registry.example/i.json",
    "ftp://registry.example/i.json", "https://registry.example\\@evil/i.json", "https:///i.json", "not a url"])
    assert.throws(() => R.setUrl(bad), /registry URL/, bad);
  assert.equal(R.config().url, "", "a refused URL is not saved");
  assert.equal(R.checkUrl("http://localhost:8080/i.json").hostname, "localhost");
  assert.equal(R.checkUrl("http://[::1]:9/i.json").hostname, "[::1]");
  assert.equal(R.checkUrl("HTTPS://Registry.Example/A").href, "https://registry.example/A");
  assert.equal(requests.length, 0);

  // ------------------------------------------------------------------ index validation
  const v = (o, re) => assert.throws(() => R.validateIndex(o, INDEX_URL), re);
  v({format: "vsx", version: 1, extensions: []}, /format/);
  v({format: "atrium-extension-index", version: 2, extensions: []}, /version/);
  v(JSON.parse(index([entry({sha256: "ABC"})])), /sha256/);
  v(JSON.parse(index([entry({sha256: digest.toUpperCase()})])), /sha256/);
  v(JSON.parse(index([entry({permissions: ["network:*.example.com"]})])), /permissions/);
  v(JSON.parse(index([entry({permissions: ["read:project", "read:project"]})])), /permissions/);
  const providerEntry = entry({permissions:["ai:provider","network:provider.example"]});
  assert.deepEqual(R.validateIndex(JSON.parse(index([providerEntry])),INDEX_URL).extensions[0].permissions,providerEntry.permissions);
  v(JSON.parse(index([entry({download: "http://evil.example/x.zip"})])), /download/);
  v(JSON.parse(index([entry({source: "javascript:alert(1)"})])), /source/);
  v(JSON.parse(index([entry({id: "nodot"})])), /publisher\.name/);
  v(JSON.parse(index([entry(), entry()])), /repeats/);
  v(JSON.parse(index([entry({signature: "sig"})])), /signature/);
  const parsed = R.validateIndex(JSON.parse(index([entry(), entry({version: "1.10.0", download: "../other/h.zip"}), entry({version: "1.9.9-beta", download: "/abs/h.zip"})])), INDEX_URL);
  assert.deepEqual(parsed.extensions.map(e => e.download), [PKG_URL, "https://registry.example/other/h.zip", "https://registry.example/abs/h.zip"], "downloads resolve against the index");
  assert.deepEqual(R.latest(parsed.extensions).map(e => e.version), ["1.10.0"], "the browse view shows the newest version");

  // --------------------------------------------- configured: only the index is fetched
  R.setUrl(INDEX_URL);
  routes = {[INDEX_URL]: index(), [PKG_URL]: genuine};
  const {index: loaded} = await R.refresh();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, INDEX_URL);
  assert.deepEqual([requests[0].init.credentials, requests[0].init.redirect, requests[0].init.cache, requests[0].init.referrerPolicy], ["omit", "error", "no-store", "no-referrer"]);
  const e = loaded.extensions[0];
  assert.equal(e.download, PKG_URL);
  assert.equal(requests.length, 1, "browsing downloads no package");

  // --------------------------------------------- a tampered package is rejected on SHA
  const tampered = bundle(manifest, "exports.activate = api => { /* injected */ };");
  routes[PKG_URL] = tampered;
  await assert.rejects(R.install(e), /SHA-256 mismatch.*Nothing was installed/);
  assert.equal(requests.at(-1).url, PKG_URL);
  assert.equal(requests.at(-1).init.credentials, "omit");
  assert.ok(!X.list().some(x => x.id === "test.hello"), "nothing installed");
  assert.deepEqual(prompts, [], "the permission prompt never appears for a tampered package");
  assert.equal(R.provenance("test.hello"), null);
  // One flipped byte is enough.
  const flipped = genuine.slice(); flipped[flipped.length - 3] ^= 1;
  await assert.rejects(R.install(e, {bytes: flipped}), /SHA-256 mismatch/);
  // A bigger package than the index declares is refused before hashing.
  await assert.rejects(R.install({...e, size: genuine.length + 1}, {bytes: genuine}), /the index says/);

  // ---------------------- matching digest but other permissions, id or version: rejected
  const greedy = bundle({...manifest, permissions: ["read:project", "ui:command", "write:edits"]});
  await assert.rejects(R.install({...e, sha256: R.sha256(greedy)}, {bytes: greedy}), /permissions the index does not list/);
  const other = bundle({...manifest, id: "test.other"});
  await assert.rejects(R.install({...e, sha256: R.sha256(other)}, {bytes: other}), /not test\.hello 1\.2\.0/);
  const older = bundle({...manifest, version: "1.0.0"});
  await assert.rejects(R.install({...e, sha256: R.sha256(older)}, {bytes: older}), /not test\.hello 1\.2\.0/);
  const junk = new TextEncoder().encode("{not json");
  await assert.rejects(R.install({...e, sha256: R.sha256(junk)}, {bytes: junk}));
  assert.deepEqual(prompts, []);
  assert.ok(!X.list().some(x => x.id === "test.hello"));

  // ---------------------- the genuine package installs through the normal permission prompt
  answer = () => null; // the user declines
  routes[PKG_URL] = genuine;
  await assert.rejects(R.install(e), /cancelled/);
  assert.ok(!X.list().some(x => x.id === "test.hello"));
  answer = r => Object.fromEntries(r.permissions.map(p => [p, true]));
  prompts.length = 0;
  const rec = await R.install(e);
  assert.equal(rec.id, "test.hello");
  assert.deepEqual(prompts, ["install:test.hello:read:project,ui:command"], "installing shows the permissions through the existing trust flow");
  assert.equal(X.list().find(x => x.id === "test.hello").version, "1.2.0");
  assert.deepEqual(X.permissions("test.hello").declared, ["read:project", "ui:command"]);
  assert.equal(R.provenance("test.hello").sha256, digest);
  assert.equal(R.provenance("test.hello").index, INDEX_URL);
  assert.equal(workers, 0, "installing runs no extension code");

  // ---------------------------- a ZIP package (with a top-level folder) updates it the same way
  const zipManifest = {...manifest, version: "1.3.0"};
  const zip = AtriumZip.create([{name: "hello/waffle-extension.json", data: JSON.stringify(zipManifest)}, {name: "hello/main.js", data: "exports.activate = () => {};"}],
    {date: new Date(2026, 0, 1)});
  const zipEntry = {...e, version: "1.3.0", sha256: R.sha256(zip), size: zip.length};
  const badZip = zip.slice(); badZip[60] ^= 0x20;
  await assert.rejects(R.install(zipEntry, {bytes: badZip}), /SHA-256 mismatch/);
  assert.equal(X.list().find(x => x.id === "test.hello").version, "1.2.0", "a tampered update leaves the installed version alone");
  await R.install(zipEntry, {bytes: zip});
  assert.equal(X.list().find(x => x.id === "test.hello").version, "1.3.0");
  assert.equal(R.provenance("test.hello").version, "1.3.0");
  // The optional canonical bundle digest (the id@sha256 project trust uses) is checked too.
  const code = {"main.js": "exports.activate = () => {};"};
  await assert.rejects(R.install({...zipEntry, bundleSha256: "0".repeat(64)}, {bytes: zip}), /bundle digest/);
  await R.install({...zipEntry, bundleSha256: X._digest(zipManifest, code).slice(7)}, {bytes: zip});

  // ---------------------------- a local index file: no network at all, packages from disk
  R.setUrl("");
  const before = requests.length;
  assert.deepEqual(await R.refresh(), {configured: false, index: null});
  const local = R.loadIndexText(index([entry({download: PKG_URL})]));
  await assert.rejects(R.install(local.extensions[0], {bytes: tampered}), /SHA-256 mismatch/);
  await assert.rejects(Promise.resolve().then(() => R.loadIndexText(index([entry()]))), /download/, "a local index needs absolute download URLs");
  const {readFileSync} = require("node:fs");
  for (const example of ["widget-inspection", "widget-rail", "ai-provider"]) {
    const dir = __dirname + "/../../extensions/examples/" + example + "/";
    const pkg = JSON.parse(readFileSync(dir + "waffle-extension.json", "utf8"));
    const files = {[pkg.main]: readFileSync(dir + pkg.main, "utf8")};
    const bytes = new TextEncoder().encode(JSON.stringify({manifest: pkg, files}));
    const listing = entry({id: pkg.id, name: pkg.name, version: pkg.version, apiVersion: pkg.apiVersion,
      publisher: pkg.publisher || pkg.id.split(".")[0], permissions: pkg.permissions, download: PKG_URL, sha256: R.sha256(bytes)});
    const [listed] = R.loadIndexText(index([listing])).extensions;
    await R.install(listed, {bytes});
    assert.deepEqual(X.permissions(pkg.id).declared, pkg.permissions);
    assert.equal(prompts.at(-1), "install:" + pkg.id + ":" + pkg.permissions.join(","));
    for (const permission of pkg.permissions) assert.ok(AtriumAPI.PERMISSIONS.includes(permission), permission + " is in the SDK contract");
  }
  assert.equal(workers, 0, "browsing or installing a widget or provider does not activate it");
  assert.equal(requests.length, before, "the local-index flow makes no request");
  assert.equal(R.enabled(), false);
  console.log("extension-registry: ok (" + requests.length + " requests, all after the user set a registry)");
})();
