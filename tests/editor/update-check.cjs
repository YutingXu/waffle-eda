"use strict";
// Updates (app/editor/update-check.js, docs/upgrading.md): hashing and Ed25519 verification, the signed
// release manifest, no network unless enabled and keyed, never trusting an unsigned or tampered
// manifest, downloads checked against the signed size and SHA-256, What's New after an update,
// and the compatibility notes. Fixtures: tests/fixtures/compat/release/ (a test key the app does
// not trust; its private key was discarded).
// Run: scripts/test-jsc.sh update-check   (or node tests/editor/update-check.cjs)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
require("../../app/formats/format-2-codec.js"); require("../../app/editor/update-check.js");
const U = AtriumUpdate, REL = path.join(__dirname, "../fixtures/compat/release");
const bytes = name => new Uint8Array(fs.readFileSync(path.join(REL, name)));
const FEED = "https://github.com/example/waffle/releases/latest/download/waffle-release.json";
const enc = s => new TextEncoder().encode(s), hexOf = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const unhex = s => Uint8Array.from(s.match(/../g), b => parseInt(b, 16));
const TEST_KEY = fs.readFileSync(path.join(REL, "test-public-key.txt"), "utf8").trim().split("\n").pop();
if (!globalThis.atob) globalThis.atob = s => Buffer.from(s, "base64").toString("binary");
const response = (status, body) => ({ok: status >= 200 && status < 300, status, arrayBuffer: async () => (typeof body === "string" ? enc(body) : body).buffer.slice(0)});

async function checkManifestBuilder() {
  const {spawnSync} = require("node:child_process");
  const {tmpdir} = require("node:os");
  const dir = fs.mkdtempSync(path.join(tmpdir(), "waffle-update-manifest-"));
  try {
    const root = path.join(__dirname, "../.."), script = path.join(root, "scripts", "release-manifest.py");
    const python = process.platform === "win32" ? "python" : "python3";
    const output = path.join(dir, "waffle-release.json");
    const filenames = ["Waffle-0.8.0.dmg", "Waffle-0.8.0-windows.zip", "waffle-eda_0.8.0_all.deb"];
    const asset = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };
    const installers = filenames.map(name => asset(name, "sample bytes for " + name));
    const archive = asset("Waffle-0.8.0-src.tar.gz", "sample source bytes");
    const identity = spawnSync(python, ["-B", path.join(root, "scripts", "release-version.py"), "--check", "--notes"], {encoding:"utf8"});
    assert.equal(identity.status, 0, identity.stderr);
    const rawNotes = fs.readFileSync(path.join(root, identity.stdout.trim()));
    const empty = asset("optional.zip", "");
    const build = (files, options = []) => spawnSync(python, [
      "-B", script, "build", "--version", "0.8.0", "--date", "2026-11-23", "--out", output,
      "--url-base", "https://github.com/example/waffle/releases/download/v0.8.0-preview.1", ...options, ...files
    ], {encoding: "utf8"});

    const buildAndRead = (files, options) => {
      const result = build(files, options);
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      return U.parseManifest(fs.readFileSync(output, "utf8"));
    };
    const plain = buildAndRead(installers);
    assert.deepEqual(plain.assets.map(row => row.name), filenames);
    assert.deepEqual(plain.notes, []);
    const withNote = buildAndRead([...installers, archive], ["--notes", "Preview notes stay separate from downloads."]);
    assert.equal(withNote.assets.at(-1).platform, "source");
    assert.deepEqual(withNote.notes, ["Preview notes stay separate from downloads."]);
    assert.deepEqual(withNote.assets.slice(0, 3), plain.assets);

    const macDigest = U.sha256(new Uint8Array(fs.readFileSync(installers[0])));
    asset(filenames[0] + ".sha256", `${macDigest}  ${filenames[0]}\n`);
    const packageScript = [
      "import runpy, sys",
      "from pathlib import Path",
      "packager = runpy.run_path(sys.argv[1])",
      "packager['write_preview_checksums'](*map(Path, sys.argv[2:]))"
    ].join("\n");
    const packaged = spawnSync(python, ["-B", "-c", packageScript, path.join(root, "scripts", "release-preview.py"),
      root, dir, ...installers], {encoding: "utf8"});
    if (packaged.error) throw packaged.error;
    assert.equal(packaged.status, 0, packaged.stderr);
    assert.equal(fs.existsSync(path.join(dir, "Release Notes.md")), false);
    assert.deepEqual(fs.readFileSync(path.join(dir, "Release-Notes.md")), rawNotes);

    const rows = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trimEnd().split(/\r?\n/).map(row => row.split("  "));
    assert.deepEqual(rows.map(([, name]) => name), [...filenames, "Release-Notes.md"]);
    const downloads = buildAndRead(rows.map(([, name]) => path.join(dir, name))).assets;
    assert.deepEqual(downloads.map(row => [row.sha256, row.name]), rows);
    const saved = [];
    for (const target of downloads) {
      assert.equal(target.url.split("/").at(-1), target.name);
      const payload = new Uint8Array(fs.readFileSync(path.join(dir, target.name)));
      const result = await U.download(target, {
        fetch: async url => { assert.equal(url, target.url); return response(200, payload); },
        save: async (name, contents) => { assert.deepEqual(contents, payload); saved.push(name); return true; },
        noSubtle: true
      });
      assert.equal(result.saved, true);
    }
    assert.deepEqual(saved, rows.map(([, name]) => name));

    const existing = fs.readFileSync(output);
    const notes = asset("Release Notes.md", rawNotes);
    const noteResult = build([...installers, notes]);
    assert.equal(noteResult.status, 1, noteResult.stderr);
    assert.match(noteResult.stderr, /Release Notes\.md.*--notes/);
    assert.deepEqual(fs.readFileSync(output), existing, "invalid input preserves the last manifest");
    fs.unlinkSync(output);
    const emptyResult = build([...installers, empty]);
    assert.equal(emptyResult.status, 1, emptyResult.stderr);
    assert.match(emptyResult.stderr, /optional\.zip.*size/);
    assert.equal(fs.existsSync(output), false, "invalid input does not publish a new manifest");
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

globalThis.__testDone = (async () => {
  // ---- hashes (FIPS 180-4 test vectors) -----------------------------------------------------------------------
  assert.equal(U.sha256(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(U.sha256(enc("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(U.sha256(enc("a".repeat(1000))), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  assert.equal(hexOf(U.sha512(enc("abc"))), "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
  assert.equal(U.sha256(bytes("Atrium-macOS.zip")), JSON.parse(new TextDecoder().decode(bytes("atrium-release.json"))).assets[0].sha256);

  // ---- Ed25519 (RFC 8032 test 1 and 2, then an openssl signature) ---------------------------------------------------
  assert.equal(U.verify(new Uint8Array(0), unhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), true, "RFC 8032 test 1");
  assert.equal(U.verify(unhex("72"), unhex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"), true, "RFC 8032 test 2");
  assert.equal(U.verify(unhex("73"), unhex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"), false, "another message");
  const manifest = bytes("atrium-release.json"), sig = Uint8Array.from(atob(new TextDecoder().decode(bytes("atrium-release.json.sig")).trim()), c => c.charCodeAt(0));
  assert.equal(U.verify(manifest, sig, TEST_KEY), true, "openssl-signed manifest");
  const tampered = manifest.slice(); tampered[40] ^= 1;
  assert.equal(U.verify(tampered, sig, TEST_KEY), false, "a changed byte fails");
  assert.equal(U.verify(manifest, sig, "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), false, "another key fails");
  assert.equal(U.verify(manifest, sig.slice(0, 63), TEST_KEY), false); assert.equal(U.verify(manifest, sig, ""), false);

  // ---- the shipped build trusts nothing until the maintainer sets a key ------------------------------------------------
  assert.equal(U.PUBLIC_KEY === "" || /^[0-9a-f]{64}$/.test(U.PUBLIC_KEY), true);
  assert.notEqual(U.PUBLIC_KEY, TEST_KEY, "the test key is never the release key");
  let calls = 0;
  const counting = async () => { calls++; return response(404, ""); };
  if (!U.PUBLIC_KEY) {
    const r = await U.check({fetch: counting});
    assert.equal(r.status, "unavailable"); assert.equal(calls, 0, "no key: nothing is fetched");
  }

  // ---- check(): signed, unsigned, tampered, newer, same --------------------------------------------------------------
  const server = (files) => async url => { calls++; const name = url.split("/").pop(); return files[name] ? response(200, files[name]) : response(404, ""); };
  const files = {"waffle-release.json": manifest, "waffle-release.json.sig": bytes("atrium-release.json.sig")};
  let r = await U.check({fetch: server(files), publicKey: TEST_KEY, url: FEED, current: "0.4.0"});
  assert.equal(r.status, "available"); assert.equal(r.manifest.app, "0.5.0");
  // An authentic older update lists its own format without promising this build can open it.
  assert.ok(r.notes.includes("Waffle 0.5.0 saves projects in format 1.1. This build uses format 2.0."));
  assert.ok(r.notes.includes("Extensions using apiVersion 1 still work."));
  assert.equal((await U.check({fetch: server(files), publicKey: TEST_KEY, url: FEED, current: "0.5.0"})).status, "up-to-date");
  await assert.rejects(U.check({fetch: server({"waffle-release.json": manifest}), publicKey: TEST_KEY, url: FEED}), /not signed/);
  await assert.rejects(U.check({fetch: server({...files, "waffle-release.json": tampered}), publicKey: TEST_KEY, url: FEED}), /signature is not valid/);
  await assert.rejects(U.check({fetch: server({...files, "waffle-release.json.sig": enc("not base64 !!")}), publicKey: TEST_KEY, url: FEED}), /signature is not valid/);
  await assert.rejects(U.check({fetch: server({}), publicKey: TEST_KEY, url: FEED}), /could not be downloaded \(404\)/);

  // ---- manifest validation ------------------------------------------------------------------------------------------
  const good = JSON.parse(new TextDecoder().decode(manifest));
  assert.throws(() => U.parseManifest(JSON.stringify({...good, version: 2})), /needs a newer Waffle/);
  assert.throws(() => U.parseManifest(JSON.stringify({...good, assets: [{...good.assets[0], url: "http://github.com/x"}]})), /https GitHub/);
  assert.throws(() => U.parseManifest(JSON.stringify({...good, assets: [{...good.assets[0], url: "https://evil.example/x"}]})), /https GitHub/);
  assert.throws(() => U.parseManifest(JSON.stringify({...good, assets: [{...good.assets[0], sha256: "x"}]})), /checksum/);
  assert.throws(() => U.parseManifest("{"), /not valid JSON/);

  // ---- downloads: only what the signed manifest describes --------------------------------------------------------------
  const asset = good.assets.find(a => a.platform === "macos");
  const saved = [];
  const dl = await U.download(asset, {fetch: async () => response(200, bytes("Atrium-macOS.zip")), save: async (n, b) => { saved.push([n, b.length]); return true; }, noSubtle: true});
  assert.deepEqual(saved, [["Atrium-macOS.zip", asset.size]]); assert.match(dl.how, /Applications/);
  const evil = bytes("Atrium-macOS.zip").slice(); evil[0] ^= 1;
  await assert.rejects(U.download(asset, {fetch: async () => response(200, evil), save: async () => assert.fail("must not save"), noSubtle: true}), /does not match the signed checksum/);
  await assert.rejects(U.download(asset, {fetch: async () => response(200, enc("short")), save: async () => assert.fail("must not save"), noSubtle: true}), /wrong size/);
  if (process.versions.node) await checkManifestBuilder();

  // ---- startup: What's New after an update; no network unless enabled ---------------------------------------------------
  const store = new Map(), storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)};
  const shown = [];
  calls = 0;
  let s = await U.startup({force: true, storage, enabled: false, fetch: counting, showWhatsNew: v => shown.push(v), now: 1e12});
  assert.equal(s.whatsNew, false, "a fresh install shows nothing"); assert.equal(JSON.parse(store.get(U.STORE)).lastVersion, U.APP_VERSION);
  assert.equal(calls, 0, "disabled: no request");
  store.set(U.STORE, JSON.stringify({format: "atrium-update", version: 1, lastVersion: "0.3.0"}));
  s = await U.startup({force: true, storage, enabled: false, fetch: counting, showWhatsNew: v => shown.push(v), now: 1e12});
  assert.equal(s.whatsNew, true); assert.deepEqual(shown, ["0.3.0"], "What's New after an update, with the previous version");
  s = await U.startup({force: true, storage, enabled: false, fetch: counting, showWhatsNew: v => shown.push(v), now: 1e12});
  assert.equal(shown.length, 1, "once");
  s = await U.startup({force: true, storage, enabled: true, fetch: server(files), publicKey: TEST_KEY, url: FEED, current: "0.4.0", showWhatsNew: () => {}, now: 2e12});
  assert.equal(s.checked, true); assert.equal(s.result.status, "available");
  calls = 0;
  s = await U.startup({force: true, storage, enabled: true, fetch: counting, publicKey: TEST_KEY, url: FEED, showWhatsNew: () => {}, now: 2e12 + 3600e3});
  assert.equal(s.checked, false); assert.equal(calls, 0, "at most once a day");

  // ---- versions and notes ----------------------------------------------------------------------------------------------
  assert.ok(U.compare("0.10.0", "0.9.9") > 0 && U.compare("1.0.0", "1.0.0") === 0 && U.compare("0.4.0", "0.4.1") < 0);
  assert.equal(U.compare(U.APP_VERSION, U.APP_VERSION + "-preview.1"), 0, "updates compare package versions numerically");
  const about = fs.readFileSync(path.join(__dirname, "../../app/editor/about.js"), "utf8");
  assert.equal(/const VERSION = "([^"]+)"/.exec(about)[1], U.APP_VERSION, "app/editor/update-check.js APP_VERSION matches app/editor/about.js");
  const page = fs.readFileSync(path.join(__dirname, "../../app/index.html"), "utf8");
  assert.equal(/name="application-version" content="([^"]+)"/.exec(page)[1], U.APP_VERSION, "the launch gate uses the installed version");
  assert.equal(U.FORMATS.at(-1)[0], AtriumFormat2.FORMAT, "the format history names the current format");
  const own = U.notes();
  assert.equal(own[0], "Projects saved with Waffle " + U.APP_VERSION + " (format " + AtriumFormat2.FORMAT + ") open in Waffle 0.7.0 and later.");
  assert.equal(own[1], "Extensions using apiVersion 1 still work.");
  const major = U.notes({...good, formats: {writes: "3.0"}, apiVersions: [2]});
  assert.ok(major.some(n => /need an update/.test(n)) && major.some(n => /format 3\.0\. This build uses format 2\.0\./.test(n)), major.join("\n"));
})();
globalThis.__testDone.catch(e => { console.error(e); process.exitCode = 1; });
