"use strict";
const assert = require("node:assert/strict");
require("../fixtures/notebook-labs.cjs").enable();
const root = __dirname + "/../../extensions/examples/";
const harness = require(root + "harness.cjs");
require("../../app/extension-host/extension-palette.js");
assert.equal(globalThis.AtriumExtensionPaletteView, undefined, "manifest declarations load without parsing palette views");
let provider, shown, handlers, invalidations = 0;
globalThis.AtriumPalette = {
  registerProvider(key, value) { assert.equal(key, "extensions"); provider = value; },
  invalidateProvider(key) { assert.equal(key, "extensions"); invalidations++; },
  present(model, calls) { shown = model; handlers = calls; }
};
const controller = () => {
  if (globalThis.AbortController) return new AbortController();
  const callbacks = new Set();
  return {signal: {aborted: false, addEventListener(_, fn) { callbacks.add(fn); }, removeEventListener(_, fn) { callbacks.delete(fn); }}, abort() {this.signal.aborted = true; for (const fn of callbacks) fn();}};
};
const req = (h, query, ctrl = controller()) => ({query, queryId: 1, signal: ctrl.signal, context: {kind: "pcb", docId: h.board().id, point: [13, 7], host: h.host, selection: ["private-object"]}});
const pkg = (id, contributes, main, files = {}) => ({"waffle-extension.json": JSON.stringify({id, name: "Scope test", apiVersion: 1, version: "1.0.0", main: "main.js", permissions: ["ui:command", "network:parts.example", "network:other.example"], contributes}), "main.js": main, ...files});
const run = async () => {
  const h = await harness.setup(), X = h.X, P = globalThis.AtriumExtensionPalette;
  assert.ok(provider);
  await h.installFolder(root + "palette-distributor", ["search.js", "parts.json"]);
  await h.installFolder(root + "palette-footprints", ["thumbnail.js"]);
  await h.installFolder(root + "palette-calculator");
  assert.ok(invalidations >= 3);
  assert.equal(h.realms.length, 0, "installing or indexing starts no workers");
  const request = req(h, "0603"), rows = provider.entries(request.context);
  const keymap = globalThis.AtriumKeymap, shortcut = "command:ext:example.divider:divider", chord = "Ctrl+Alt+F9";
  assert.equal(P.shortcutId(shortcut), shortcut);
  keymap.setBindings(shortcut, [chord]);
  for (const kind of ["schematic", "pcb"]) assert.equal(keymap.resolve(chord,{kind,canvas:true}), shortcut);
  const conflicting = keymap.registerCommand({id:"ordinary-test-command",title:"Existing command",run(){}});
  keymap.setBindings("ordinary-test-command", [chord]);
  assert.ok(keymap.conflicts().some(c => new Set([c.a.command,c.b.command]).has(shortcut) && new Set([c.a.command,c.b.command]).has("ordinary-test-command")));
  conflicting.dispose(); let opened;
  globalThis.AtriumNavCommon = {openPalette(mode, chain, args){opened = [mode,chain,args];}};
  keymap.command(shortcut).run(); assert.deepEqual(opened, ["command",null,{source:"shortcut",entryKey:shortcut}]);
  const canvas = {closest:()=>null}, surface = {kind:"symbol",canvas};
  const keyboard = {key:"F9",code:"F9",ctrlKey:true,altKey:true,target:canvas,preventDefault(){},stopPropagation(){}};
  assert.equal(P.surfaceShortcut(keyboard,surface),true); assert.equal(opened[2].target,canvas);
  assert.equal(P.surfaceShortcut({...keyboard,isComposing:true},surface),false);
  assert.equal(P.surfaceShortcut({...keyboard,target:{closest:()=>({})}},surface),false);
  keymap.setBindings(shortcut,["Ctrl+Alt+F9 K"]);
  assert.equal(P.surfaceShortcut(keyboard,surface),true);
  assert.equal(P.surfaceShortcut({...keyboard,key:"k",code:"KeyK",ctrlKey:false,altKey:false},surface),true);
  keymap.setBindings(shortcut,[chord]);
  assert.deepEqual(rows.map(e => e.key), ["insert:ext:example.footprints:footprint", "command:ext:example.divider:divider"]);
  assert.equal(provider.entries({kind: "schematic"}).length, 1, "PCB insert item uses editor context");
  assert.deepEqual(rows[0].preview(), {kind: "text", text: "View pad layouts and place the selected footprint."});
  const streamed = [];
  await provider.stream(request, chunk => streamed.push(...chunk));
  assert.equal(streamed.length, 2);
  assert.ok(streamed.every(r => r.source === "Benchstock" && r.icon === "search" && r.key.startsWith("search:ext:example.distributor:stock:") && !r.boost));
  assert.equal(X.workers.length, 0, "finished read-only search reclaims its worker");
  await streamed[0].run(request);
  assert.equal(shown.kind, "detail"); assert.equal(shown.title, "RC0603 · 10 kΩ");
  await handlers.run("stock");
  assert.equal(shown.kind, "list"); assert.equal(shown.items[0].accessory, "6000 available");
  await streamed[1].actions[0].run(request);
  assert.equal(shown.items[0].accessory, "3100 available", "secondary action uses its own row");
  assert.deepEqual(h.history, [], "search, activation and browsing create no edits");
  await rows[0].run(request);
  assert.equal(shown.kind, "grid");
  assert.ok(shown.items.length >= 5);
  const first = shown.items[0], thumbnail = first.thumbnail;
  assert.ok(thumbnail.data.startsWith("data:image/png;base64,iVBORw0KGgo"));
  assert.ok(/pads/.test(thumbnail.alt));
  await handlers.run(first.id);
  assert.equal(shown.kind, "detail"); assert.equal(shown.blocks[0].image.data, thumbnail.data);
  const count = h.board().items.length;
  await handlers.run("place");
  assert.match(shown.text, /^Placed /);
  assert.equal(h.history.length, 1); assert.equal(h.board().items.length, count + 1);
  const placed = h.board().items.at(-1); assert.equal(placed.kind, "part"); assert.equal(placed.x, 13); assert.equal(placed.y, 7);
  assert.ok(h.prompts.includes("review:example.footprints")); h.undo(); assert.equal(h.board().items.length, count);
  await rows[1].run(request);
  assert.equal(shown.kind, "form");
  const form = handlers, model = shown;
  await form.submit({vin: "5", rtop: "bad", rbottom: "2000"}, "calculate");
  assert.equal(shown, model); assert.match(h.messages.at(-1), /Upper resistor/);
  await form.submit({vin: "5", rtop: "1000", rbottom: "2000"}, "calculate");
  assert.equal(shown.kind, "detail"); assert.match(shown.text, /evaluator is unavailable/);
  const [declaration] = P.mathFunctions();
  assert.equal(declaration.id, "example.divider.vout"); assert.match(declaration.packageDigest, /^sha256:[a-f0-9]{64}$/);
  let calls = 0;
  globalThis.AtriumCalculations = {async evaluateExtensionFunction(d, args, opts) {
    assert.deepEqual(d, declaration); assert.deepEqual(opts.functions, {});
    assert.deepEqual(args, [{value: 5, dimension: "voltage"}, {value: 1000, dimension: "resistance"}, {value: 2000, dimension: "resistance"}]);
    calls++; return {value: 10 / 3, dimension: "voltage", display: "3.333 V"};
  }};
  await rows[1].run(request); await handlers.submit({vin: "5", rtop: "1000", rbottom: "2000", unrelated: "ignored"}, "calculate");
  assert.equal(shown.text, "3.333 V"); assert.equal(shown.outputType, "quantity"); assert.equal(calls, 1);
  assert.equal(shown.blocks[0].kind,"math"); assert.match(shown.blocks[0].text,/frac/);
  assert.deepEqual(shown.blocks[1].body.blocks[0].runs[0],{type:"text",text:"Input ",bold:true});
  await assert.rejects(P.evaluateMath(declaration.id, "2.0.0", []), /unavailable/);
  await assert.rejects(P.evaluateMath(declaration.id, "1.0.0", [{dimension: "voltage", value: Infinity}]), /dimensions/);
  let validations = 0;
  globalThis.AtriumCalculations.validateExtensionFunctions = async (defs, {functions}) => {
    validations++; assert.equal(defs.length, 1); assert.equal(functions[defs[0].id].packageDigest, defs[0].packageDigest);
    return defs[0].expression === "invalid body" ? {ok:false, diagnostic:{code:"syntax",message:"Invalid function syntax."}} : {ok:true};
  };
  const update = h.files(root + "palette-calculator"), changed = JSON.parse(update["waffle-extension.json"]);
  changed.contributes.mathFunctions[0].expression = "invalid body"; update["waffle-extension.json"] = JSON.stringify(changed);
  await assert.rejects(X.install(update), /Invalid function syntax/);
  assert.deepEqual(P.mathFunctions()[0], declaration, "an invalid update preserves the installed package, digest and grants");
  let registryChanges = 0; const off = P.onMathFunctionsChanged(() => {registryChanges++;});
  const stale = rows[1]; await X.setEnabled("example.divider", false); shown = null;
  await stale.run(request); assert.equal(shown, null); assert.deepEqual(P.mathFunctions(), []); assert.equal(keymap.command(shortcut), null);
  await X.setEnabled("example.divider", true); assert.equal(P.mathFunctions().length, 1); assert.equal(validations,2,"enabling and installation both check the shared AST"); assert.equal(registryChanges,2); off(); assert.equal(keymap.resolve(chord,{kind:"schematic",canvas:true}),shortcut);

  const tests = {searchProviders: [{id: "lookup", name: "Scope", command: "scope.open", module: "search.js", hosts: ["parts.example"]}], paletteCommands: [{id: "open", name: "Scope", command: "scope.open"}]};
  const sc = `exports.search = async (q, {emit,signal}) => {
    let other; try { await fetch("https://other.example/parts"); } catch { other = "denied"; }
    const label = [Object.keys(q).sort().join("/"),typeof api,typeof document,typeof fetch,other].join(" ");
    if(q.query === "network") { await fetch("https://parts.example/current", {signal}); }
    if(q.query === "slow") { await new Promise(r => setTimeout(r,70)); }
    for(let i=0;i<16;i++) emit(Array.from({length:12},(_,j)=>({id:"part-"+(i*12+j),label,boost:9999,source:"fake",key:"builtin",icon:"https://other.example",actions:[]})));
  }`;
  const rich = {kind:"richText",body:{font:"serif",blocks:[{style:"paragraph",runs:[
    {type:"text",text:"<b>price</b>",bold:true,href:"https://parts.example"}, {type:"field",expression:"project.title"},
    {type:"math",tex:"x+1",italic:true}, {type:"other",text:"unused"}]}]}};
  const main = `exports.activate=api=>api.commands.register("scope.open",e=>({kind:"detail",title:"Scoped",text:Object.keys(e).sort().join("/"),html:"omitted",href:"omitted",blocks:[{kind:"image",image:{kind:"png",data:"https://parts.example/x",alt:"x"}},{kind:"math",text:"x+1"},${JSON.stringify(rich)}]}));`;
  const bundle = pkg("test.scope", tests, main, {"search.js": sc});
  await X.install(bundle); await X.grant("test.scope", "network:parts.example", true); await X.grant("test.scope", "network:other.example", true);
  const scoped = {...req(h, "x"),scope:"provider",providerId:"test.scope:lookup"};
  const received = []; await provider.stream(scoped, b => received.push(...b));
  assert.equal(received.length, 24); assert.equal(new Set(received.map(r=>r.key)).size, 24);
  assert.match(received[0].label, /editorKind\/query undefined undefined function denied/);
  assert.ok(received.every(r => r.source === "Scope test" && !r.boost && r.icon === "chip"));
  await received[0].run(scoped); assert.equal(shown.html, undefined); assert.equal(shown.href, undefined); assert.deepEqual(shown.blocks, [
    {kind:"math",text:"x+1"}, {kind:"richText",body:{blocks:[{style:"paragraph",runs:[
      {type:"text",text:"<b>price</b>",bold:true},{type:"math",tex:"x+1",italic:true}]}]}}
  ]);
  assert.equal(shown.text, "editorKind/itemId/query/type", "no project data or host objects reach an extension without read:project");
  const abort = controller(), cancelled = [];
  const running = provider.stream({...scoped, ...req(h, "slow", abort)}, b=>cancelled.push(...b));
  await h.wait(12); abort.abort(); await running; await h.wait(80);
  assert.deepEqual(cancelled, []); assert.ok(!X.workers.some(p=>p.pool.startsWith("search:")));
  const served = new Set();
  await Promise.all(Array.from({length: 6}, (_, i) => provider.stream({...scoped, query: "burst" + i}, b => {if (b.length) served.add(i);})));
  assert.ok(served.size <= 3 && served.has(5), "rate-limited bursts keep the last waiting query");
  const originalFetch = globalThis.fetch; let receivedRequest, networkStarted;
  const started = new Promise(resolve => { networkStarted = resolve; });
  globalThis.fetch = (url, options) => new Promise((_resolve, reject) => {
    receivedRequest = {url, options}; networkStarted(); options.signal?.addEventListener("abort", () => reject(Error("cancelled")));
  });
  try {
    if (typeof AbortController === "function") {
      const ctrl = controller(), results = [];
      const pending = provider.stream({...scoped, ...req(h, "network", ctrl)}, b => results.push(...b));
      await started;
      assert.equal(receivedRequest.url, "https://parts.example/current"); assert.equal(receivedRequest.options.credentials, "omit"); assert.equal(receivedRequest.options.redirect, "error");
      ctrl.abort(); await pending; assert.equal(receivedRequest.options.signal.aborted, true, "cancellation aborts before response headers arrive");
      assert.deepEqual(results, []);
    }
  } finally { globalThis.fetch = originalFetch; }
  const invalid = (patch, pattern) => { const data = {...JSON.parse(bundle["waffle-extension.json"]), contributes: patch}; assert.throws(()=>X.validateManifest(data,bundle), pattern); };
  invalid({searchProviders:[{...tests.searchProviders[0],hosts:["unapproved.example"]}]}, /hosts/);
  invalid({searchProviders:[{...tests.searchProviders[0],module:"../other.js"}]}, /packaged/);
  invalid({paletteCommands:[{...tests.paletteCommands[0],command:"waffle.delete"}]}, /extension-owned/);
  invalid({mathFunctions:[{...declaration,id:"other.vout"}]}, /package-qualified/);
  const hyphenated = {...JSON.parse(bundle["waffle-extension.json"]), id:"vendor-tools.regulator", contributes:{mathFunctions:[{...declaration,id:"vendor-tools.regulator.divider-out"}]}};
  assert.equal(X.validateManifest(hyphenated,bundle),hyphenated);
  await X.grant("test.scope", "ui:command", false); assert.ok(!provider.entries(scoped.context).some(r=>r.source==="Scope test"));
  await X.uninstall("example.divider"); assert.equal(keymap.command(shortcut),null); assert.equal(P.shortcutId(shortcut),null);
  X.shutdown(); console.log("palette extension contributions, three examples, scoped search, grants, cancellation, limits, math dispatch and one-step Undo passed");
};
globalThis.__testDone = run().catch(e => {console.error(e.stack || e); globalThis.AtriumExtensions?.shutdown(); if (globalThis.process) process.exitCode=1; throw e;});
