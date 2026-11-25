"use strict";
// The example extensions (extensions/examples/*/test.cjs), the New Extension scaffold, developer
// mode, Messages reports and the example console scripts, all in the extension sandbox harness
// (extensions/examples/harness.cjs: a separate JS realm per extension, the real host and checks).
//   scripts/test-jsc.sh extension-examples      or      node tests/extensions/extension-examples.cjs
const harness = require("../../extensions/examples/harness.cjs");
const fs = require("node:fs");
const ROOT = __dirname + "/../../";
const EX = ROOT + "extensions/examples/";
const EXAMPLES = ["bom-template", "unconnected-pins", "teardrop-audit", "silk-labels", "net-colour-presets"];

// ------------------------------------------------ New Extension scaffold (CLI and in-app)
async function scaffold(h) {
  const {assert, X} = h;
  require(ROOT + "app/extension-template.js"); require(ROOT + "app/extension-host/extension-dev.js");
  const D = globalThis.AtriumExtensionDev;
  assert.throws(() => D.names("nodot"), /yourname\.my-extension/);
  assert.deepEqual(D.names("acme.net-length_report"), {__ID__: "acme.net-length_report", __NAME__: "Net Length Report", __PUBLISHER__: "acme", __PREFIX__: "netLengthReport"});
  // The in-app scaffold is a zip the Extensions manager can install as it is.
  const made = await D.scaffold("acme.hello-nets", {save: false});
  assert.equal(made.name, "hello-nets.zip");
  const zipFile = {name: made.name, arrayBuffer: async () => made.bytes.buffer.slice(made.bytes.byteOffset, made.bytes.byteOffset + made.bytes.byteLength)};
  const files = await X.packageFromFiles([zipFile]);
  assert.deepEqual(Object.keys(files).sort(), ["README.md", "main.js", "waffle-extension.json"], "a zip with one top folder; test.cjs is not part of the package");
  assert.ok(!/__[A-Z]+__/.test(Object.values(made.files).join("")), "every placeholder is filled");
  const manifest = JSON.parse(files["waffle-extension.json"]);
  assert.deepEqual(manifest.permissions, ["read:project", "ui:command", "ui:panel"], "the scaffold starts least-privilege");
  // Its own test passes in the harness (the scaffold's test.cjs, with the path to this checkout).
  const test = D.scaffoldFiles("acme.hello-nets", ROOT.replace(/\/$/, "")).files["test.cjs"];
  const mod = {exports: {}};
  new Function("module", "exports", "require", "__dirname", test)(mod, mod.exports, id => (/harness\.cjs$/.test(id) ? harness : require(id)), "/scaffold");
  await mod.exports({...h, files: () => files}, "/scaffold");
  // The CLI's bundle is current (scripts/new-extension.py --bundle --check does the same in CI).
  const template = Object.fromEntries(["waffle-extension.json", "main.js", "test.cjs", "README.md"].map(n => [n, String(fs.readFileSync(ROOT + "extensions/template/" + n, "utf8"))]));
  assert.deepEqual({...globalThis.AtriumExtensionTemplate.files}, template, "app/extension-template.js matches extensions/template/");
  await X.uninstall("acme.hello-nets");
}

// ------------------------------------------------------------------ developer mode
async function developer(h) {
  const {assert, X} = h;
  const id = "dev.probe";
  const pkg = (main, perms = ["read:project", "ui:command"]) => ({
    "waffle-extension.json": JSON.stringify({id, name: "Probe", version: "0.0.1", apiVersion: 1, main: "main.js", activationEvents: ["onCommand:probe.run"],
      permissions: perms, contributes: {commands: [{command: "probe.run", title: "Probe"}]}}),
    "main.js": main, "notes.md": "ignored", "lib/util.js": "exports.n = 2;"});
  const probe = n => `const u = require("./lib/util.js"); exports.activate = api => api.commands.register("probe.run", async () => {
    console.log("run", ${n});
    return {n: ${n} * u.n, parts: await api.items.count({kind: "part"}), globals: [typeof document, typeof fetch, typeof localStorage, typeof Atrium, typeof AtriumHost]};
  });`;

  h.developerMode = false;
  assert.equal(X.developerMode, false, "off by default");
  await assert.rejects(X.installDev(pkg(probe(1))), /Developer mode is off/, "nothing loads unpacked while developer mode is off");
  h.developerMode = true;
  h.prompts.length = 0;
  const e1 = await X.installDev(pkg(probe(1)));
  assert.deepEqual(h.prompts, ["install:" + id], "loading shows the permission prompt");
  const row = () => X.list().find(e => e.id === id);
  assert.equal(row().origin, "dev"); assert.equal(row().developer, true);
  assert.match(row().hash, /^sha256:[0-9a-f]{64}$/); assert.equal(row().hash, X._digest(JSON.parse(pkg("")["waffle-extension.json"]), {"main.js": probe(1), "lib/util.js": "exports.n = 2;"}),
    "pinned to sha256 of the manifest and the .js/.json files loaded");
  const r1 = await X.execute("probe.run");
  assert.deepEqual(r1, {n: 2, parts: 7, globals: ["undefined", "undefined", "undefined", "undefined", "undefined"]}, "fully sandboxed: no DOM, network, storage or editor globals");
  assert.ok(h.logs(id).some(l => l.text === "run 1"), "console output reaches the developer console");
  assert.ok(h.logs(id).some(l => /unpacked \(developer mode\).*sha256:/.test(l.text)), "the log records the digest of the load");
  assert.ok(X.workers.some(w => w.pool === "ext:" + id && w.members.length === 1), "its own worker");

  // Reload with new code and the same permissions: a new pin, the earlier answers kept.
  h.prompts.length = 0;
  await X.installDev(pkg(probe(5)));
  assert.notEqual(row().hash, e1.hash, "each load is pinned to its own digest");
  assert.deepEqual(h.prompts, [], "same permissions: no prompt again");
  assert.equal((await X.execute("probe.run")).n, 10, "the reloaded code runs");
  // Reload asking for more: the prompt shows again, and declining keeps the previous load.
  h.answers.install = null;
  await assert.rejects(X.installDev(pkg(probe(9), ["read:project", "ui:command", "write:edits"])), /cancelled/);
  assert.deepEqual(h.prompts, ["install:" + id], "new permissions ask again");
  assert.equal((await X.execute("probe.run")).n, 10, "declining keeps the previous load");
  h.answers.install = r => Object.fromEntries(r.permissions.map(p => [p, !p.startsWith("network:")]));
  // Same permission checks as any extension.
  await X.installDev(pkg(`exports.activate = api => api.commands.register("probe.run", () => api.transaction("x", tx => tx.remove(${JSON.stringify(h.board().items[0].id)})));`));
  await assert.rejects(X.execute("probe.run"), /propose:edits or write:edits/, "undeclared capabilities are refused");

  // It cannot shadow an installed or built-in extension.
  await assert.rejects(X.installDev({...pkg(""), "waffle-extension.json": JSON.stringify({...JSON.parse(pkg("")["waffle-extension.json"]), id: "waffle.calculators"})}), /built into Waffle/);
  await X.install(h.files(EX + "bom-template"));
  await assert.rejects(X.installDev({...pkg(""), "waffle-extension.json": JSON.stringify({...JSON.parse(pkg("")["waffle-extension.json"]), id: "atrium-samples.bom-template"})}), /already installed/);
  await assert.rejects(X.installDev({"main.js": ""}), /no waffle-extension\.json/);

  // Turning developer mode off stops unpacked code from starting.
  await X.installDev(pkg(probe(3)));
  X.stopAll("test");
  h.developerMode = false;
  await assert.rejects(X.execute("probe.run"), /Developer mode is off/);
  h.developerMode = true;
  assert.equal((await X.execute("probe.run")).n, 6);
  await X.unloadDev(id);
  assert.ok(!X.list().some(e => e.id === id), "unloaded");
  assert.ok(!X.commands().some(c => c.id === "probe.run"), "its commands go with it");
  await assert.rejects(X.unloadDev("atrium-samples.bom-template"), /unpacked/, "unload is only for unpacked extensions");
  // Code is kept in memory only: no install record for the next start.
  assert.ok(!X.list().some(e => e.origin === "dev"));
  h.developerMode = false;
}

// ------------------------------------------------------------ Messages from extensions
async function reports(h) {
  const {assert, X} = h;
  await X.install({"waffle-extension.json": JSON.stringify({id: "test.reporter", name: "Reporter", version: "1.0.0", apiVersion: 1, main: "main.js",
    activationEvents: ["onCommand:rep.run"], permissions: ["ui:command"]}),
  "main.js": `exports.activate = api => api.commands.register("rep.run", n => api.ui.showMessage("done", {messages: [
    {class: "Fatal", text: "<b>pwned</b>", objectId: 42, point: [1, "x"]}, {class: "Error", text: "real", objectId: "abc", point: [1, 2]},
    ...Array.from({length: n || 0}, (_, i) => ({class: "Info", text: "row " + i}))]}));`});
  await X.execute("rep.run");
  const rows = h.reported("Reporter (extension)");
  assert.deepEqual(rows.map(r => [r.class, r.text, r.objectId, r.point]), [["Info", "<b>pwned</b>", undefined, undefined], ["Error", "real", "abc", [1, 2]]],
    "no Fatal class, ids and points only when well-formed, text kept as text");
  assert.ok(rows.every(r => r.source === "Reporter (extension)"), "the visible Source always says (extension)");
  await X.execute("rep.run", 2500);
  assert.equal(h.reported("Reporter (extension)").length, 2001, "capped at 2000 rows plus a note");
  await X.uninstall("test.reporter");
}

// ------------------------------------------------------------ example console scripts
async function scripts(h) {
  const {assert} = h;
  const S = globalThis.AtriumScripting, read = n => String(fs.readFileSync(EX + "scripts/" + n, "utf8"));
  const base = h.project, board = base.documents.find(d => d.kind === "pcb"), sheet = base.documents.find(d => d.kind === "schematic");
  const ok = r => { assert.equal(r.ok, true, r.error && r.error.message); return r; };

  // Renumber by position: shuffle the resistors, renumber, check reading order on both documents.
  const shuffled = JSON.parse(JSON.stringify(base));
  const b = shuffled.documents.find(d => d.kind === "pcb"), s = shuffled.documents.find(d => d.kind === "schematic");
  // Give the resistor that comes first in reading order the higher number (on both documents, by link).
  const order = b.items.filter(i => /^R\d$/.test(i.ref)).sort((x, y) => Math.abs(x.y - y.y) > 1 ? x.y - y.y : x.x - y.x);
  const want = new Map(order.map((p, n) => [p.link, "R" + (order.length - n)]));
  for (const d of [b, s]) for (const p of d.items) if (want.has(p.link) && /^R\d$/.test(p.ref)) p.ref = want.get(p.link);
  let r = ok(await S.runHeadless(shuffled, read("renumber-by-position.js"), {documentId: b.id, args: {prefixes: ["R"]}}));
  const rs = r.project.documents.find(d => d.kind === "pcb").items.filter(i => i.ref?.startsWith("R")).sort((x, y) => x.ref.localeCompare(y.ref));
  assert.ok(rs[0].y < rs[1].y - 1 || Math.abs(rs[0].y - rs[1].y) <= 1 && rs[0].x <= rs[1].x, "R1 comes first in reading order");
  const byLink = d => Object.fromEntries(r.project.documents.find(x => x.kind === d).items.filter(i => i.link).map(i => [i.link, i.ref]));
  assert.deepEqual(byLink("schematic"), byLink("pcb"), "linked parts keep matching designators");
  assert.equal(r.transactions, 1, "one undo step: " + JSON.stringify([r.result, r.steps, r.log]));
  r = ok(await S.runHeadless(r.project, read("renumber-by-position.js"), {documentId: b.id, args: {prefixes: ["R"]}}));
  assert.equal(r.result, "Already in order.");

  // Select by footprint size.
  r = ok(await S.runHeadless(base, read("select-by-footprint.js"), {documentId: board.id, args: {size: "0603"}}));
  assert.deepEqual(r.result.sort(), ["C1", "C2", "R1", "R2"]);
  r = ok(await S.runHeadless(base, read("select-by-footprint.js"), {documentId: board.id}));
  assert.deepEqual(r.result, [], "no 0402 parts on the example board");

  // Export net lengths: the CSV goes through files.export.
  r = ok(await S.runHeadless(base, read("export-net-lengths.js"), {documentId: board.id}));
  assert.ok(r.result.length > 3 && r.result[0].length >= r.result[1].length, "longest first");
  r = ok(await S.runHeadless(base, read("export-net-lengths.js"), {documentId: board.id, args: {nets: ["VIN"]}}));
  assert.deepEqual(r.result.map(x => x.net), ["VIN"]);

  // Widen power tracks: one transaction, only power nets.
  r = ok(await S.runHeadless(base, read("widen-power-tracks.js"), {documentId: board.id, args: {width: 0.6}}));
  assert.ok(r.result.widened > 0 && r.transactions === 1);
  const after = r.project.documents.find(d => d.kind === "pcb").items.filter(i => i.kind === "track");
  assert.ok(after.filter(t => /^(GND|VDD|VIN)$/.test(t.net)).every(t => t.width >= 0.6) && after.some(t => t.net === "BUF" && t.width < 0.6));

  // Snap to grid: move a part off-grid on the sheet, snap it back.
  const off = JSON.parse(JSON.stringify(base)), sh = off.documents.find(d => d.kind === "schematic");
  sh.items.find(i => i.ref === "R1").x += 0.3;
  r = ok(await S.runHeadless(off, read("snap-selection-to-grid.js"), {documentId: sh.id, args: {grid: 1.27}}));
  assert.deepEqual(r.result, ["R1"]);
  r = ok(await S.runHeadless(r.project, read("snap-selection-to-grid.js"), {documentId: sh.id, args: {grid: 1.27}}));
  assert.match(r.result, /Already on/);
  void sheet;

  // The same text in the editor's console path (a fresh sandboxed worker per run, console permissions).
  h.reset(); h.open("pcb");
  const live = await h.X.runScript(read("select-by-footprint.js"), {args: {size: "0603"}});
  assert.equal(live.ok, true, live.error && live.error.message);
  assert.equal(h.selection.size, 4, "the console run selects the parts");
  assert.equal((await h.X.runScript(read("export-net-lengths.js"))).ok, true);
  assert.equal(h.exported.at(-1)[0], "net-lengths.csv", "and saves through the save dialog");
  const widen = await h.X.runScript(read("widen-power-tracks.js"));
  assert.equal(widen.ok, true); assert.equal(widen.transactions, 1);
  h.reset();
}

// One public v1 workflow shared with the MCP stdio test. Only the extension
// registration and transport differ between hosts.
async function publicWidening(h) {
  const {assert, X} = h, dir = ROOT + "tests/fixtures/extension-api-v1/";
  const original = String(fs.readFileSync(dir + "power-tracks.json", "utf8"));
  const source = String(fs.readFileSync(dir + "widen-workflow.js", "utf8")).replace(
    "/* public-example */", () => String(fs.readFileSync(EX + "scripts/widen-power-tracks.js", "utf8")));
  const fixture = JSON.parse(original), [board] = fixture.documents;
  const snapshot = {
    apiVersion: 1, name: fixture.name, units: fixture.units,
    document: {id: board.id, name: board.name, kind: board.kind, grid: board.grid, itemCount: board.items.length, outline: board.outline},
    tracks: board.items.map(({id, net, width, points}) => ({id, net, width, points}))
  };
  const edited = {...snapshot, tracks: snapshot.tracks.map(track => track.net === "GND" ? {...track, width: 0.5} : track)};
  const expected = {before: snapshot, edit: {widened: 1, applied: 1}, after: edited};
  const id = "test.public-api-v1", command = "publicApiV1.widen";
  const originalProposal = globalThis.AtriumProposal, originalReview = h.answers.review, previews = [];
  globalThis.AtriumProposal = {...originalProposal, inspect(proposal, project, limit) {
    const rows = originalProposal.inspect(proposal, project, limit);
    previews.push({limit, rows: rows.length});
    return rows;
  }};
  h.project = JSON.parse(original);
  h.open("pcb");
  const live = () => JSON.stringify(h.project);
  const width = () => h.board().items.find(item => item.net === "GND").width;
  const before = live(), steps = h.history.length, starts = h.realms.length;
  try {
    await X.install({
      "waffle-extension.json": JSON.stringify({id, name: "Public v1 example contract", version: "1.0.0", apiVersion: 1, main: "main.js",
        activationEvents: ["onCommand:" + command], permissions: ["read:project", "propose:edits", "ui:command"]}),
      "main.js": "exports.activate = api => api.commands.register(" + JSON.stringify(command) + ", async args => {\n" + source + "\n});"
    });
    assert.equal(h.realms.length, starts, "install and listing start no workers");
    assert.equal(X.commands().some(c => c.owner === id), false, "the runtime command is lazy");
    assert.equal(X.list().some(e => e.id === id), true);
    assert.equal(h.realms.length, starts);

    let reviews = 0;
    h.answers.review = request => {
      reviews++;
      assert.equal(request.rows.length, 1);
      assert.equal(request.rows[0].op.before, 0.2);
      assert.equal(request.rows[0].op.after, 0.5);
      assert.equal(live(), before, "review still sees the unmodified project");
      return request.rows.map(row => row.index);
    };
    const read = await X.execute(command, {inspect: true});
    assert.deepEqual(read, {before: snapshot, edit: null, after: snapshot});
    assert.equal(h.realms.length, starts + 1);
    assert.equal(width(), 0.2);
    assert.equal(h.history.length, steps);
    assert.deepEqual(await X.execute(command), expected);
    assert.equal(reviews, 1);
    assert.equal(h.history.length, steps + 1);
    h.undo();
    assert.equal(live(), before);
    assert.deepEqual(previews.splice(0), [{limit: 2000, rows: 1}], "only the actual extension review renders preview rows");

    const readOnly = await X.runScript(source, {args: {inspect: true}, write: false});
    assert.deepEqual(readOnly.value, read);
    assert.equal(readOnly.undoSteps, 0);
    const denied = await X.runScript(source, {write: false});
    assert.equal(denied.ok, false);
    assert.match(denied.error.message, /propose:edits or write:edits/);
    assert.equal(live(), before);
    const consoleRun = await X.runScript(source);
    assert.equal(consoleRun.ok, true, consoleRun.error?.message);
    assert.deepEqual(consoleRun.value, expected);
    assert.equal(consoleRun.transactions, 1);
    assert.equal(consoleRun.undoSteps, 1);
    assert.equal(h.history.length, steps + 1);
    h.undo();
    assert.equal(live(), before);
    const headless = await AtriumScripting.runHeadless(fixture, source);
    assert.equal(headless.ok, true, headless.error?.message);
    assert.deepEqual(headless.result, expected);
    assert.equal(headless.transactions, 1);
    assert.deepEqual(previews.splice(0), [], "console and headless direct commits have no review rows to render");
    const proposalOnly = await AtriumScripting.runHeadless(fixture, source, {write: false, propose: true});
    assert.equal(proposalOnly.ok, true, proposalOnly.error?.message);
    assert.deepEqual(proposalOnly.result, {before: snapshot, edit: {widened: 1, applied: 0}, after: snapshot});
    assert.equal(proposalOnly.transactions, 0);
    assert.deepEqual(previews.splice(0), [{limit: 0, rows: 0}], "unapplied proposals keep their validation");

    let approve, shown;
    const reviewShown = new Promise(resolve => { shown = resolve; });
    h.answers.review = request => new Promise(resolve => { approve = () => resolve(request.rows.map(row => row.index)); shown(); });
    const pending = X.execute(command);
    await reviewShown;
    h.host.edit(() => { h.board().items.find(item => item.net === "GND").width = 0.3; });
    approve();
    await assert.rejects(pending, /changed since/);
    assert.equal(width(), 0.3);
    assert.equal(h.history.length, steps + 1, "the stale proposal publishes no edit");
    h.undo();
    assert.equal(live(), before);
  } finally {
    await X.uninstall(id);
    globalThis.AtriumProposal = originalProposal;
    h.answers.review = originalReview;
    h.reset();
  }
}

harness.run([
  ...EXAMPLES.map(n => [require(EX + n + "/test.cjs"), EX + n, n]),
  [scaffold, null, "scaffold"], [developer, null, "developer mode"], [reports, null, "Messages reports"], [scripts, null, "example scripts"], [publicWidening, null, "public API v1 power tracks"]
]);
