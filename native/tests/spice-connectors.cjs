"use strict";
// A saved bench runs in the packaged extension worker through the desktop JS bridge and the
// native runner. The configured simulator is the synthetic, local fake_spice.py executable.
const assert = require("node:assert/strict");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
for (const name of ["core/model", "library/parts", "core/spatial", "checks/altium-rules", "checks/rules", "checks/connectivity", "editor/keymap", "automation/proposal",
  "project/variants", "formats/bom", "core/atrium-api", "workers/extension-host-worker", "extension-host/extensions", "native-bridge/external-tools", "extensions/manifests"])
  require("../../app/" + name + ".js");
const {realmWorker} = require("../../tests/extensions/extension-realm.js");

async function test() {
  const ext = AtriumExtensions, project = AtriumParts.example(), [sheet, board] = project.documents;
  const source = sheet.items.find(i => i.ref === "J1");
  source.parameters = {"Spice.Prefix": "V", "Spice.Pins": "2 3", DC: "5"};
  const other = Atrium.sheet("schematic", "Probe sheet"), load = {...sheet.items.find(i => i.ref === "R2"), id: "load", ref: "R60", link: "link-R60"};
  const pin = Atrium.pins(load, project.library.find(d => d.id === load.def), "schematic")[0].at;
  other.items.push(load, {id:"filter-wire", kind:"wire", points:[pin, [pin[0]-3,pin[1]]]},
    {id:"filter-label", kind:"netlabel", x:pin[0]-3, y:pin[1], text:"FILTER"});
  project.documents.push(other);
  let active = board.id, revision = 0, located = null;
  const review = [], renderers = new Set(), requests = [];
  globalThis.AtriumNavHost = {addRenderer(fn) { renderers.add(fn); return () => renderers.delete(fn); }, invalidate() {}};
  const program = path.join(__dirname, "fake_spice.py");
  globalThis.AtriumHost = {
    externalToolList: () => ({tools: {ltspice: {path: program}, ngspice: {path: program}}}),
    externalRun: request => {
      requests.push(request);
      const p = spawnSync("python3", [program, "--bridge"], {input: JSON.stringify(request), encoding: "utf8"});
      if (p.status !== 0) throw Error(p.stderr || "native runner failed");
      return JSON.parse(p.stdout);
    }
  };
  const host = {project: () => project, documentId: () => active, revision: () => revision, selection: () => new Set(),
    edit(fn) { fn(); revision++; ext.notify("documentChanged"); }, activate(id) { active = id; ext.notify("activeDocumentChanged"); },
    locate(id) { located = id; }, info() {}};
  const attach = () => ext.attach(host, {createWorker: realmWorker, consent(r) { assert.equal(r.kind, "review"); review.push(r); return true; }});
  const command = (name, ...args) => ext.execute("spice." + name, ...args);
  const panel = () => ext._panel("waffle.spice", "waffle.spice");
  attach();
  try {
    await command("show"); await command("analysis", "op");
    await command("setProbes", {nets: "FILTER"});
    await command("saveBench", {name: "Divider bias", engine: "ngspice"});
    const bench = project.simulation.benches[0];
    assert.deepEqual(bench.probes, ["FILTER"]); assert.equal(review.length, 1);
    // Restart the worker with the PCB active. Engine and probes come from the saved project.
    ext.shutdown(); attach();
    await command("show");
    assert.equal((await command("run")).analysis, "op");
    assert.equal(requests.at(-1).tool, "ngspice");
    assert.ok([...renderers].every(r => !r(board)), "no schematic decorations on the PCB");
    assert.ok([...renderers].some(r => r(sheet)), "schematic is decorated even when a bench runs from the PCB");
    assert.ok([...renderers].some(r => r(other)), "each sheet with the probed net has its own overlay");
    host.activate(sheet.id);
    await command("show");
    const drawn = [];
    const ctx = new Proxy({}, {get: (_, k) => k === "fillText" ? (...args) => drawn.push(args) : () => {}});
    for (const r of renderers) r(sheet)?.overlay(ctx, {scale: 4, dpr: 1, width: 3000, height: 3000, worldToScreen: p => [500 + p[0]*4,500 + p[1]*4]});
    const reading = drawn.find(([text]) => /^FILTER\s+2\.5 V$/.test(text));
    assert.ok(reading, "rawfile voltage drawn on the FILTER net");
    const conn = Atrium.connectivity(sheet, new Map(project.library.map(d => [d.id,d])));
    const pins = sheet.items.filter(i => i.kind === "part").flatMap(i => Atrium.pins(i, project.library.find(d => d.id === i.def), "schematic")
      .filter(p => conn.byPin.get(i.id + "/" + p.number) === "FILTER").map(p => p.at));
    assert.ok(pins.some(([x,y]) => Math.abs(reading[1] - (500 + 4*x)) < 20 && Math.abs(reading[2] - (500 + 4*y)) < 20), "reading follows a connected pin");
    const op = await command("simulate", {bench: bench.id});
    assert.equal(op.nodes.FILTER, 2.5); assert.equal(op.currents.VJ1, -0.001);
    const dc = await command("simulate", {analysis: "dc", source: "VJ1", start: 1, stop: 2, step: 1, engine: "ngspice"});
    assert.deepEqual(dc.x, [1,2]); assert.deepEqual(dc.signals.FILTER, [0.5,1]);
    const ac = await command("simulate", {analysis: "ac", sweep: "lin", points: 2, fstart: 1, fstop: 2, engine: "ltspice"});
    assert.ok(Math.abs(ac.signals.FILTER.phase[0] + 45) < 1e-9);
    const tran = await command("simulate", {analysis: "tran", tstep: 1, tstop: 2, engine: "ltspice"});
    assert.deepEqual(tran.signals.FILTER, [0.5,1]);
    await command("analysis", "op");
    assert.equal((await command("run", {engine: "LTspice"})).analysis, "op");
    source.parameters.DC = "-1";
    for (const engine of ["LTspice", "ngspice"]) {
      host.activate(board.id);
      const r = await command("run", {engine});
      assert.match(r.error, /Error on line|Invalid voltage/);
      const link = panel().filter(v => v.type === "list").flatMap(v => v.items).find(i => i.command === "spice.locatePart");
      assert.equal(link.label, "J1"); await ext.execute(link.command, ...link.args);
      assert.equal(active, sheet.id); assert.equal(located, source.id);
    }
    const runs = requests.length;
    for (const card of [".include models.lib", ".lib models.lib nominal", ".control", "V2 a 0 PWL file=stimulus"]) {
      await assert.rejects(command("simulate", {engine:"ngspice", analysis:"op", netlist:"* bench\n" + card + "\n.end\n"}), /self-contained/);
    }
    assert.equal(requests.length, runs, "unsupported decks never launch the external tool");
    assert.ok(requests.every(r => r.files.length === 1 && r.files[0].name === "deck.cir" ));
    // Approval (native/external_tools.py): normal runs stay inside the declared argument template, so
    // the host asks once per extension version instead of for every command.
    assert.ok(requests.every(r => r.extensionHash && r.argTemplate.length), "runs carry the version hash and the declared template");
    const check = spawnSync("python3", ["-c", "import json,sys; sys.path.insert(0, sys.argv[1]); import external_tools as T; rs = json.load(sys.stdin); " +
      "print(json.dumps([T.outside_template(r['args'], r['argTemplate'], [f['name'] for f in r['files']], r['outputs']) for r in rs]))", path.join(__dirname, "..")],
      {input: JSON.stringify(requests), encoding: "utf8"});
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout).filter(a => a.length), [], "no run argument outside the template");
  } finally { ext.shutdown(); }
}
test().then(() => console.log("SPICE connectors: saved bench, rawfiles, pin anchor, runner and error links OK"), e => { console.error(e); process.exitCode = 1; });
