"use strict";
// Your First Board tutorial (app/editor/tutorial.js), headless: the whole tutorial is driven to completion
// with Skip, which runs the same operations as the MCP tools; every step must then complete from
// the project's state (a change subscription), not from a "Next" click. Also: the live key map in
// the instructions, the Altium/KiCad tracks, pause on another project, resume, and the string table.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "net-ties", "connectivity", "altium-rules", "pcb-appearance", "pcb-draw", "component-classes",
  "query", "stackup", "viastack", "polygon-pour", "rooms", "rules", "pcb-edit", "eco", "sch-author", "annotate", "messages", "multichannel", "erc",
  "router", "diffpair", "autorouter", "library-panel", "footprint-wizard", "starter-library", "templates", "zip", "pcb-pours", "variants", "bom", "rigid-flex",
  "board-shape", "step-export", "fab-outputs", "impedance", "z-clearance", "flex-drc", "drc", "keymap", "tutorial"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const T = AtriumTutorial, A = Atrium;

// A minimal editor host: project, current document, edit() as one undo step, change events.
function fakeHost(project) {
  let p = project, current = p.documents[0].id;
  const listeners = new Map(), emit = k => { for (const f of listeners.get(k) || []) f(); };
  const host = {
    acts: [], infos: [], exported: [], edits: 0,
    project: () => p, doc: () => p.documents.find(d => d.id === current), currentId: () => current, defs: () => new Map(p.library.map(d => [d.id, d])),
    selectDocument(id) { if (p.documents.some(d => d.id === id)) { current = id; emit("document"); } },
    edit(fn) { const before = JSON.stringify(p); try { fn(); } catch (e) { p = JSON.parse(before); throw e; } host.edits++; emit("change"); },
    on(k, f) { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(f); return () => listeners.get(k).delete(f); },
    async replaceProject(np) { p = np; current = (np.documents.find(d => d.kind === "pcb") || np.documents[0]).id; emit("change"); return true; },
    isStarter: () => false, isDirty: () => true, info: s => host.infos.push(s), act: a => host.acts.push(a),
    async exportFile(name, bytes) { host.exported.push({name, size: bytes.length}); return true; }
  };
  return host;
}
const memory = () => { const m = new Map(); return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m}; };
const userProject = () => { const p = AtriumParts.example(); p.name = "My own project"; return p; };

const run = async () => {
  // ---- strings: one table, every step has its texts in every track, t() fills {vars}
  assert.equal(T.STEPS.length, 15);
  for (const s of T.STEPS) for (const k of ["title", "body", "wait", "altium", "kicad"]) assert.ok(T.STRINGS["step." + s.id + "." + k], s.id + "." + k);
  assert.equal(T.t("card.step", {n: 3, total: 15}), "Step 3 of 15");
  globalThis.AtriumI18n = {t: k => k === "tutorial.title" ? "Ma première carte" : k};
  assert.equal(T.t("title"), "Ma première carte", "routes through AtriumI18n.t when present");
  assert.equal(T.t("intro.start"), "Start", "falls back to the table");
  delete globalThis.AtriumI18n;

  // ---- keys come from the live key map and follow rebinding and presets
  AtriumKeymap.useStorage(memory());
  const wire = T.STEPS.find(s => s.id === "wire");
  const before = T.keyFor(wire, "schematic");
  assert.ok(before, "the wire step names its key");
  AtriumKeymap.setBindings("route", [{key: "Ctrl+Alt+W", when: ""}]);
  assert.notEqual(T.keyFor(wire, "schematic"), before, "rebinding changes the instruction");
  assert.match(T.keyFor(wire, "schematic"), /W/);
  AtriumKeymap.resetCommand("route");
  assert.equal(T.keyFor(wire, "schematic"), before);
  assert.equal(T.menuPath(wire, "schematic"), "Place › Wire", "menu path without menus comes from the table");

  // ---- the whole tutorial, headless: Skip every step; each completes from state
  const storage = memory(), host = fakeHost(userProject()), c = T.create(host, {storage, sync: true});
  const events = [];
  c.on(ev => events.push(typeof ev === "string" ? ev : ev.type + ":" + ev.step.id));
  assert.equal(c.state().status, "intro");
  assert.equal(await c.begin({track: "kicad"}), true);
  assert.equal(c.state().status, "running");
  assert.equal(host.project().name, "My First Board (tutorial)", "works in a practice project");
  assert.equal(c.returnTo.project.name, "My own project", "keeps the user's project to go back to");
  assert.equal(c.state().step, "led");
  const order = [];
  for (let guard = 0; c.state().status === "running" && guard < 20; guard++) {
    const s = c.step(), was = c.index;
    // Nothing completes a step except the state it asks for.
    assert.equal(s.done(c.facts(), c), false, s.id + " is not done before it is performed");
    const moved = await c.skip();
    assert.equal(c.error, "", s.id + ": " + c.error);
    assert.ok(moved && c.index > was, s.id + " completed after Skip");
    order.push(s.id);
  }
  assert.deepEqual(order, T.STEPS.map(s => s.id));
  assert.equal(c.state().status, "finished");
  assert.deepEqual(c.state().skipped.length, 15);
  // The board the skip actions built is real: routed, DRC-clean, poured, with fab files.
  const f = c.facts();
  assert.equal(f.parts.length, 3); assert.equal(f.boardParts.length, 3);
  assert.equal(f.unrouted, 0, "every connection routed");
  assert.ok(f.pour, "GND pour");
  assert.equal(c.ran.drc.errors, 0, "DRC zero");
  assert.equal(c.ran.erc.errors, 0, "ERC zero");
  assert.ok(host.exported.length === 1 && /\.zip$/.test(host.exported[0].name) && host.exported[0].size > 1000, JSON.stringify(host.exported));
  assert.ok(host.acts.includes("compile") && host.acts.includes("drc"), "checks also run the real command (Messages)");
  assert.ok(events.includes("done:led") && events.includes("finished"));
  A.validate(JSON.parse(JSON.stringify(host.project())));
  assert.deepEqual(T.progress(storage), {index: 15, total: 15, finished: true, track: "kicad"});
  c.close();
  assert.equal(c.state().status, "closed", "the finished coach closes immediately");
  assert.equal(T.progress(storage).finished, true, "closing keeps the recorded completion");
  c.reopen();
  assert.equal(c.state().status, "finished", "reopening shows the completed board step");
  // Back to the user's own project.
  assert.equal(await c.goBack(), true);
  assert.equal(host.project().name, "My own project");
  c.dispose();

  // ---- doing the step by hand (an edit through the host) completes it; work out of order counts
  const h2 = fakeHost(userProject()), c2 = T.create(h2, {storage: memory(), ui: false, sync: true});
  await c2.begin({});
  const f2 = c2.facts(), sch = f2.sch;
  // The user places a resistor first (out of order), then the LED.
  h2.edit(() => AtriumSchAuthor.placePart(h2.project(), {sheet: sch.id, def: "std-r", x: 100, y: 80}));
  assert.equal(c2.state().step, "led", "the resistor alone does not finish the LED step");
  h2.edit(() => AtriumSchAuthor.placePart(h2.project(), {sheet: sch.id, def: "starter-led-0805", x: 130, y: 80}));
  assert.equal(c2.state().step, "connector", "LED done, and the resistor step completed in turn");
  // Annotate: designators are already numbered at placement, so the step waits for Annotate itself.
  await c2.skip(); await c2.skip(); await c2.skip();
  assert.equal(c2.state().step, "annotate");
  h2.edit(() => {});
  assert.equal(c2.state().step, "annotate", "an unrelated edit does not complete Annotate");
  c2.seen.annotate = true; c2.evaluate();
  assert.equal(c2.state().step, "erc", "the Annotate dialog was used");

  // ---- deviation: another project pauses the tutorial; coming back resumes it
  await h2.replaceProject(userProject());
  assert.equal(c2.state().status, "paused");
  h2.edit(() => { h2.project().name = "Edited elsewhere"; });
  assert.equal(c2.state().status, "paused", "edits in another project change nothing");
  assert.equal(await c2.returnToSandbox(), true);
  assert.equal(c2.state().status, "running"); assert.equal(c2.state().step, "erc");
  c2.dispose();

  // ---- resume: saved progress rebuilds the practice board up to the saved step
  const s3 = memory(), h3 = fakeHost(userProject()), c3 = T.create(h3, {storage: s3, ui: false, sync: true});
  await c3.begin({track: "altium"});
  for (let i = 0; i < 9; i++) await c3.skip();
  assert.equal(c3.state().step, "place");
  c3.close(); c3.dispose();
  assert.deepEqual(T.progress(s3), {index: 9, total: 15, finished: false, track: "altium"});
  const h4 = fakeHost(userProject()), c4 = T.create(h4, {storage: s3, ui: false, sync: true});
  await c4.begin({resume: true});
  assert.equal(c4.state().step, "place", "resumed at the saved step");
  assert.equal(c4.track, "altium");
  assert.ok(c4.facts().outline && c4.facts().synced, "the earlier steps were replayed");
  assert.equal(h4.exported.length, 0, "replay writes no files");
  // Restart forgets the progress.
  await c4.restart();
  assert.equal(c4.state().step, "led");
  assert.equal(T.progress(s3).index, 0);
  c4.dispose();
  console.log("SHIM-OK tutorial");
};
run().catch(e => { console.log("SHIM-FAIL " + e.message + "\n" + e.stack); });
