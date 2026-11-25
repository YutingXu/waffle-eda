"use strict";
// Projects panel › Add Existing to Project… (openFiles(files, {into: true})) in the real editor
// (tests/integration/integration.cjs) while hosting a live session (app/project/collab-presence.js over a scripted transport):
//   * the document joins the open project as an edit: no "replace" event, so the session stays joined
//     (it once left with "this window opened another project"), and the new document reaches the peers;
//   * the Messages panel, the other documents' views and their hidden layers stay as they were.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {File} = require("node:buffer");
const {setup} = require("../integration/integration.cjs");

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const until = async (test, what) => { for (let i = 0; i < 200 && !test(); i++) await tick(10); assert.ok(test(), what); };

(async () => {
  await setup();
  const H = globalThis.AtriumNavHost;
  await globalThis.AtriumLazy.need(["AtriumCollabCRDT", "AtriumCollabTransport", "AtriumCollabCursors", "AtriumCollabObjectMotion"]);
  const sent = [], PEER = "p" + "H".repeat(22);
  globalThis.AtriumCollabTransport = {...globalThis.AtriumCollabTransport,
    async connect() { return {peer: PEER, room: "r", state: "open", rtc: true, send(kind, body) { sent.push({kind, body}); return Promise.resolve(); }, paths: () => new Map(), close() {}}; }};
  const Live = globalThis.AtriumCollabLive;
  await Live.start("wss://relay.test");
  await until(() => Live.session()?.r, "hosting a live session");
  const peer = globalThis.AtriumCollabCRDT.create({replica: "recipient", snapshot: Live.session().r.snapshot()});

  let replaced = 0;
  H.on("replace", () => replaced++);
  const first = H.currentId(), before = H.project().documents.length;
  // A view, a hidden layer and a message to keep.
  const cam = H.view().camera();
  H.view().restoreCamera({...cam, cx: cam.cx + 12.5, cy: cam.cy - 4, scale: cam.scale * 1.75});
  const moved = H.view().camera();
  H.hiddenLayers().add("Bottom Overlay");
  globalThis.AtriumMessages.set("Compiler", [{class: "Warning", text: "Keep this message", document: "Board"}]);
  sent.length = 0;

  const text = fs.readFileSync(path.join(__dirname, "../fixtures/import/child.kicad_sch"), "utf8");
  assert.ok(await H.openFiles([new File([text], "child.kicad_sch")], {into:true}));
  await until(() => H.project().documents.length === before + 1, "the document joined the project");
  const added = H.project().documents.at(-1);
  assert.equal(H.currentId(), added.id, "the added document opens");
  assert.equal(replaced, 0, "adding into the open project is not a project replacement");
  assert.ok(Live.active() && Live.session()?.r, "still in the live session");
  await until(() => sent.some(m => m.kind === "ops"), "the added document is sent to the session");
  const batches = sent.filter(m => m.kind === "ops").map(m => m.body);
  assert.ok(batches.some(b => b.ops.some(op => op.t === "add" && op.o === added.id)), "the document addition is part of the published plan");
  for (const b of batches) peer.receive(b, {author:PEER});
  assert.deepEqual(peer.project().documents.find(d => d.id === added.id), structuredClone(added), "the recipient reconstructs the imported document");
  assert.deepEqual(peer.vv(), Live.session().r.vv());
  assert.ok(globalThis.AtriumMessages.messages().some(m => m.text === "Keep this message"), "messages stay");

  H.selectDocument(first);
  assert.equal(H.currentId(), first);
  assert.deepEqual(H.view().camera(), moved, "the first document's view is kept");
  assert.ok(H.hiddenLayers().has("Bottom Overlay"), "its hidden layers are kept");
  assert.ok(Live.active(), "still live after switching back");

  Live.leave(true);
  console.log("Passed Add Existing to Project in a live session: no replace, session kept, views, hidden layers and messages kept.");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
