"use strict";
// Lazy module loader (app/lazy.js): registry consistency with index.html and the files on disk,
// dependency order, de-duplication, stylesheets, failures and retries, against a fake document.
// Runs under Node and under JavaScriptCore (scripts/test-jsc.sh lazy).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const app = path.join(__dirname, "../../app");
const read = f => String(fs.readFileSync(path.join(app, f), "utf8"));
const exists = f => { try { fs.readFileSync(path.join(app, f)); return true; } catch { return false; } };

require("../../app/lazy.js");
const L = globalThis.AtriumLazy;
require("../../app/checks/diagnostics.js");
require("../../app/editor/keymap.js");
const D = globalThis.AtriumDiagnostics;
const html = read("index.html");
const eager = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
const eagerCss = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]);

const landContours = "pcb/land-contours.js";
const curveKernel = "pcb/resolved-geometry-curves.js";
assert.ok(!eager.includes(landContours), "physical land contours are absent from cold canvas startup");
assert.deepEqual(L.files("AtriumLandContours"), [curveKernel, landContours]);
assert.ok(L.files("AtriumPolygonPour").includes(curveKernel), "a direct pour request prepares the pad curve sampler");


const commitGraph = "ui/commit-graph.js";
assert.ok(!L.files("AtriumHistoryEntry").includes(commitGraph), "idle History chrome doesn't need commit graph drawing");
const historyViewFiles = L.files("AtriumHistoryView");
assert.ok(historyViewFiles.includes(commitGraph) &&
  historyViewFiles.indexOf(commitGraph) < historyViewFiles.indexOf("history/history-view.js"),
  "cold History loads the graph before the view");

const styledFeatures = ["checks/erc.css", "pcb/stackup.css", "pcb/board-shape.css", "pcb/viastack.css",
  "checks/rules-editor.css", "pcb/polygon-pour.css", "project/variants.css"];
const styleSlots = [...html.matchAll(/<template id="lazy-style:([^"]+)"><\/template>/g)].map(([, href]) => href);
assert.deepEqual(styleSlots, styledFeatures, "feature styles keep their original relative cascade slots");
for (const href of styledFeatures) {
  assert.ok(!eagerCss.includes(href), href + " makes no eager request");
  assert.ok(L.stylesheets().includes(href), href + " still has a lazy owner");
}

// ---- registry against the tree ------------------------------------------------------
assert.ok(eager.includes("lazy.js") && eager.indexOf("lazy.js") < eager.indexOf("editor/editor.js"), "index.html loads lazy.js before editor.js");
for (const f of L.files()) {
  assert.ok(exists(f), f + " exists");
  assert.ok(!eager.includes(f), f + " is lazy, so index.html must not load it");
}
for (const c of L.stylesheets()) { assert.ok(exists(c), c + " exists"); assert.ok(!eagerCss.includes(c), c + " is lazy"); }
function publishes(source, name) {
  const aliases = [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*globalThis\s*[,;]/g)]
    .map(match => match[1].replace(/[$]/g, "\\$&"));
  const receiver = ["globalThis", ...aliases].join("|");
  return new RegExp("\\b(?:" + receiver + ")\\." + name + "\\s*=").test(source);
}
for (const name of L.modules()) {
  const files = L.files(name), defined = files.some(file => publishes(read(file), name));
  assert.ok(defined, name + " is defined by one of its files");
}
// Every action the editor gates names registered modules, and every lazy-gated menu item exists.
const menuActions = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]));
for (const a of L.actions()) for (const kind of ["schematic", "pcb"]) for (const n of L.forAction(a, kind) || []) assert.ok(L.modules().includes(n), a + " -> " + n);
for (const a of ["bom", "fab", "drc", "erc", "compare", "export", "teardrops", "extensions", "view-config", "stackup"]) assert.ok(menuActions.has(a) && L.forAction(a, "pcb"), a);
assert.equal(L.forAction("route", "schematic"), null, "schematic wires need no router");
assert.deepEqual(L.forAction("route", "pcb"), ["AtriumRouter"], "interactive routing uses its own JavaScript solver");
for (const a of ["repour", "repour-selected", "drc", "connectivity"])
  assert.ok(L.forAction(a, "pcb").includes("AtriumEngine"), a + " requests its board kernel");
assert.equal(L.forAction("select", "pcb"), null);
// Design Review's Board connectivity dialog reads the solver's result (ctx.connections), so it loads the solver.
assert.ok(L.files("AtriumDesignReview").includes("checks/connectivity.js"), "Design Review loads the connectivity solver");

// Eager modules must not capture a lazy global when they load (it would stay undefined).
const lazyGlobals = new Set(L.modules().concat(["AtriumDiffPair", "AtriumFanout", "AtriumAPI", "AtriumScripting", "AtriumBOMOptimiser", "AtriumSCH", "AtriumPCB", "AtriumSourceFile", "CFB"]));
for (const f of eager) {
  if (f === "editor/editor.js" || f === "lazy.js") continue;
  for (const m of read(f).matchAll(/^ {0,2}(?:const|let|var)\s[^\n]*?=\s*\(?(?:globalThis\.|window\.|root\.)?(Waffle[A-Za-z]+|CFB)\b/gm))
    assert.ok(!lazyGlobals.has(m[1]), f + " captures lazy " + m[1] + " at load");
}
// Startup only installs the gesture and browser-file entry points. Each consumer demands its provider.
for (const f of ["editor/crossprobe-input.js", "formats/io-browser.js"]) assert.ok(eager.includes(f), f + " installs before the editor");
for (const f of ["editor/crossprobe.js", "formats/io.js", "editor/windowed-table.js"]) assert.ok(L.files().includes(f) && !eager.includes(f), f + " is lazy");
for (const a of ["cross-probe", "cross-select", "context-menu"]) assert.deepEqual(L.forAction(a, "schematic"), ["AtriumCrossProbe"]);
assert.deepEqual(L.files("AtriumContextMenu"), ["editor/context-menu.js"], "laying out ordinary menus keeps Cross Probe cold");
for (const action of ["select-net", "highlight-net", "net-properties", "delete-net-copper"])
  assert.deepEqual(L.forAction(action, "pcb"), ["AtriumCrossProbe", "AtriumContextMenu"]);
assert.ok(L.files().indexOf("formats/io.js") < L.files().indexOf("workers/import-worker-client.js"), "the import client gets the raw source reader");

// The editor resolves workflow modules only through optional lookups.
assert.ok(!/[^.?\w]AtriumDesignReview\.connectivity\}/.test(read("editor/editor.js").replace(/globalThis\.AtriumDesignReview&&\{open:AtriumDesignReview\.connectivity\}/, "")), "workflow() must not dereference a missing AtriumDesignReview");
assert.deepEqual(L.validatorsFor({bomViews: [], layoutBlocks: []}), ["AtriumBOM", "AtriumBlocks"]);
assert.deepEqual(L.validatorsFor({}), []);
// Lazy pass 2: the board core and the library editors are lazy, gated and validated.
for (const f of ["schematic/eco.js", "pcb/rooms.js", "checks/rules.js", "checks/altium-rules.js", "formats/import-link.js", "pcb/stackup.js", "pcb/viastack.js", "pcb/polygon-pour.js", "library/library-panel.js", "editor/nets-table.js", "library/part-inspector.js", "library/footprint-wizard.js", "library/footprint-editor.js", "library/symbol-editor.js"])
  assert.ok(L.files().includes(f) && !eager.includes(f), f + " is lazy");
assert.deepEqual(L.board(), ["AtriumStackup", "AtriumViaStack", "AtriumPolygonPour", "AtriumRooms", "AtriumRules", "AtriumPCBDraw"]);
for (const a of ["room-move", "rooms-fit", "rooms-lock", "rooms-show"]) assert.deepEqual(L.forAction(a, "pcb"), ["AtriumRooms"], a);
assert.deepEqual(L.forAction("eco", "schematic"), ["AtriumECO", "AtriumRooms"]);
assert.deepEqual(L.forAction("save", "pcb"), ["AtriumECO"], "saving writes the sorted ECO file format");
assert.deepEqual(L.validatorsFor({documents: [{kind: "pcb"}]}), ["AtriumRules"]);
assert.deepEqual(L.validatorsFor({rules: {}, documents: [{kind: "schematic"}]}), ["AtriumRules"]);
const scopeBook=(scope,extra={})=>({version:3,list:[{id:"rule",type:"ercUnconnectedPins",enabled:true,scope,...extra}]});
const all={languageVersion:1,source:"object"}, scoped={languageVersion:1,source:'object where component.designator = "J1"'};
assert.deepEqual(L.validatorsFor({rules:scopeBook(all),documents:[]}),["AtriumRules"]);
assert.deepEqual(L.validatorsFor({rules:scopeBook(scoped,{enabled:false}),documents:[]}),["AtriumRules"]);
assert.deepEqual(L.validatorsFor({rules:scopeBook(scoped,{severity:"off"}),documents:[]}),["AtriumRules","AtriumDesignQuery"],"a scoped ERC suppression still needs applicability");
assert.deepEqual(L.validatorsFor({rules:scopeBook(all,{type:"clearance",scope2:scoped}),documents:[]}),["AtriumRules","AtriumDesignQuery"],"second-side queries count");
assert.equal(L.needsRuleQuery({...scopeBook(scoped,{type:"width",set:"Fab"}),ruleSets:[{name:"Fab",enabled:false}]},"pcb"),false);
assert.equal(L.needsRuleQuery({list:[null],ruleSets:"invalid"}),false,"structural validators handle malformed books");
assert.deepEqual(L.validatorsFor({documents: [{kind: "schematic"}]}), []);
for (const a of ["library-panel", "footprint-wizard", "footprint-editor", "symbol-editor", "edit-footprint", "edit-symbol", "library-sources"])
  assert.deepEqual(L.forAction(a, "schematic"), ["AtriumLibrary"], a);
assert.ok(L.forAction("rules", "pcb").includes("AtriumRules") && L.forAction("stackup", "pcb").includes("AtriumStackup"));
assert.deepEqual(L.forAction("viaTemplates", "pcb"), ["AtriumViaStack"]);
assert.deepEqual(L.forAction("via", "pcb"), ["AtriumViaStack", "AtriumRules"], "placing a via checks manufacturing rules for its stack");
assert.equal(L.forAction("via", "schematic"), null);
// Modules that call the board core get it as a dependency.
for (const n of ["AtriumRouter", "AtriumDRC", "AtriumPCBDraw", "AtriumFabOutputs", "AtriumLength", "AtriumRigidFlex", "AtriumKiCad", "AtriumAutorouter", "AtriumFabProfiles"]) {
  const order = []; for (const f of L.files()) order.push(f);
  assert.ok(order.indexOf("checks/rules.js") < order.indexOf({AtriumRouter: "pcb/router.js", AtriumDRC: "checks/drc.js", AtriumPCBDraw: "pcb/pcb-draw.js", AtriumFabOutputs: "formats/fab-outputs.js",
    AtriumLength: "pcb/length-tuning.js", AtriumRigidFlex: "pcb/rigid-flex.js", AtriumKiCad: "formats/kicad-export.js", AtriumAutorouter: "pcb/autorouter.js", AtriumFabProfiles: "formats/fab-profiles.js"}[n]), n + " loads after rules.js");
}

// Lightweight pass 3: printing, variants, multichannel and the board shape dialog are lazy; the
// Path2D recorder stays eager so cached paths print.
assert.ok(eager.includes("core/path-record.js") && eager.indexOf("core/path-record.js") < eager.indexOf("canvas/canvas.js"), "the Path2D recorder runs before any drawing");
for (const f of ["formats/pdf.js", "formats/print.js", "project/variants.js", "schematic/multichannel.js", "pcb/board-shape-ui.js", "formats/board-shape-sources.js"]) assert.ok(L.files().includes(f) && !eager.includes(f), f + " is lazy");
assert.ok(eager.includes("pcb/board-shape-core.js"), "board shape rendering and validation stay eager");
assert.ok(L.files().includes("pcb/board-shape.js") && !eager.includes("pcb/board-shape.js"), "board shape authoring is lazy");
const curves = "pcb/resolved-geometry-curves.js";
assert.ok(!eager.includes(curves), "the curve resolver loads only on board or format demand");
assert.deepEqual(L.files("AtriumBoardShape"), [curves, "pcb/board-shape.js"], "authoring loads its physical curve dependency first");
assert.deepEqual(L.files("AtriumConnectivity"), [curves, "checks/connectivity.js"], "physical connectivity loads its copper geometry first");
assert.ok(L.boardRenderers({documents:[{kind:"pcb", boardShape:{cutouts:[[]]}}]}).includes("AtriumGeometryCurves"));
assert.ok(!L.boardRenderers({documents:[{kind:"pcb"}]}).includes("AtriumGeometryCurves"), "board references stay cold");
assert.ok(L.boardRenderers({documents:[{kind:"pcb", items:[]}]}).includes("AtriumGeometryCurves"), "materialized boards load synchronous copper geometry before paint");
for (const n of ["AtriumBoardShapeEditing", "AtriumBoardShapeSources", "AtriumDXF", "AtriumSTEP", "AtriumViaFence"]) {
  const files = L.files(n);
  assert.ok(files.includes("pcb/board-shape.js") && files.indexOf("pcb/board-shape.js") < files.length - 1, n + " gets authoring before first use");
}
assert.ok(!L.files(L.board()).includes("pcb/board-shape.js"), "the board readers leave authoring cold");
assert.deepEqual(L.forAction("print", "pcb"), ["AtriumPrint"]);
assert.deepEqual(L.forAction("variants", "schematic"), ["AtriumVariants"]);
for (const a of ["board-shape", "board-dimensions", "board-wizard", "import-dxf", "export-dxf"]) assert.ok(L.forAction(a, "pcb").includes("AtriumBoardShapeUI"), a);
assert.deepEqual(L.validatorsFor({variants: []}), ["AtriumVariants"]);
assert.deepEqual(L.validatorsFor({multichannel: {}}), ["AtriumMultichannel"]);
assert.deepEqual(L.validatorsFor({documents: [{kind: "schematic", items: [{kind: "sheetsymbol"}]}]}), ["AtriumMultichannel"], "hierarchical projects get channel designators");
assert.deepEqual(L.validatorsFor({documents: [{kind: "schematic", items: [{kind: "part"}]}]}), []);
{ // PCB text and net names are demanded before the first nonempty board. Rich lettering adds vectorization.
  for (const f of ["canvas/stroke-font.js", "pcb/pcb-text.js", "canvas/vectorize.js", "pcb/pcb-text-rich.js", "canvas/pcb-net-labels.js"])
    assert.ok(L.files().includes(f) && !eager.includes(f), f + " is lazy");
  const base = "AtriumPCBText", nets = "AtriumPCBNetLabels", rich = "AtriumPCBTextRich", board = items => ({documents: [{kind: "pcb", items}]});
  const boardReaders = ["AtriumRules", "AtriumGeometryCurves", "AtriumConnectivity"];
  assert.deepEqual(L.validatorsFor(board([{kind: "label", text: "A", font: "truetype"}])), [...boardReaders, base, nets, rich]);
  assert.deepEqual(L.validatorsFor(board([{kind: "label", text: "A", inverted: true}])), [...boardReaders, base, nets, rich]);
  assert.deepEqual(L.validatorsFor(board([{kind: "label", text: "A"}, {kind: "part"}])), [...boardReaders, base, nets]);
  assert.deepEqual(L.validatorsFor(board([])), boardReaders);
  assert.deepEqual(L.validatorsFor({documents: [{kind: "pcb", items: [], pcbDrawing: {annotations: {"components6/data#0": [{field: "ref", font: "barcode"}]}}}]}), [...boardReaders, rich]);
  assert.deepEqual(L.validatorsFor({library: [{footprint: {shapes: [{kind: "text", font: "truetype"}]}}]}), [rich], "footprint text");
  const order = L.files();
  assert.ok(order.indexOf("canvas/stroke-font.js") < order.indexOf("pcb/pcb-text.js") && order.indexOf("canvas/stroke-font.js") < order.indexOf("formats/fab-outputs.js"));
  for (const consumer of ["pcb/pcb-draw.js", "pcb/pcb-text-rich.js", "library/catalogue.js", "library/footprint-editor.js", "formats/pdf.js"])
    assert.ok(order.indexOf("pcb/pcb-text.js") < order.indexOf(consumer), consumer + " loads after the stroke renderer");
  assert.ok(order.indexOf("canvas/vectorize.js") < order.indexOf("pcb/pcb-text-rich.js") && order.indexOf("pcb/pcb-text-rich.js") < order.indexOf("formats/fab-outputs.js"));
  assert.ok(order.indexOf("canvas/vectorize.js") < order.indexOf("editor/logo-creator.js"), "the Logo Creator traces with vectorize.js");
}
// Schematic objects draw eagerly; placing them (sch-object-tools.js) loads on the first Place command.
assert.ok(eager.includes("schematic/sch-objects.js") && L.files().includes("schematic/sch-object-tools.js") && !eager.includes("schematic/sch-object-tools.js"));
{ // Outputs that follow variants and channels get them as dependencies.
  const order = L.files();
  for (const f of ["formats/bom.js", "formats/fab-outputs.js", "formats/step-export.js", "analysis/stress.js"]) assert.ok(order.indexOf("project/variants.js") < order.indexOf(f), f + " loads after variants.js");
  for (const f of ["schematic/eco.js", "checks/erc.js", "formats/bom.js", "pcb/rooms.js", "notebook/annotate.js", "core/atrium-api.js"]) assert.ok(order.indexOf("schematic/multichannel.js") < order.indexOf(f), f + " loads after multichannel.js");
  assert.ok(order.indexOf("formats/pdf.js") < order.indexOf("formats/print.js"));
  // output-jobs.js is registered in index.html: it needs the writer and variants too.
  assert.ok(/AtriumOutputJobs"[^)]*"AtriumVariants","AtriumPDF"/.test(html), "output jobs load variants and the PDF writer");
}

// ---- loader behaviour against a fake document -----------------------------------------
async function main() {
  const appended = [], tick = () => new Promise(r => setTimeout(r, 0));
  let failNext = null, variantSheet, failedStyle;
  const cascade = styleSlots.map(href => ({id:"lazy-style:" + href}));
  function attach(node) {
    appended.push(node.src || node.href);
    if (node.href === "project/variants.css") { variantSheet = node; return; }
    // Scripts run in insertion order (async=false); stylesheets just load.
    setTimeout(() => {
      if (node.src === failNext || node.href === failedStyle && failedStyle) {
        failNext = failedStyle = null; node.onerror(); return;
      }
      if (motionProviders.has(node.src)) require(path.join(app, node.src));
      else if (node.src && defines[node.src]) globalThis[defines[node.src]] = {from: node.src};
      (node.onload || (() => {}))();
    }, 0);
  }
  const motionProviders = new Set(["ui/surface-motion.js", "editor/editor-motion.js", "automation/command-broker.js",
    "automation/command-catalog.js", "editor/motion-service.js"]);
  const defines = {"core/zip.js": "AtriumZip", "formats/bom.js": "AtriumBOM", "formats/bom-optimiser.js": "AtriumBOMOptimiser", "pcb/router.js": "AtriumRouter", "core/geometry.js": "AtriumGeometry", "pcb/land-contours.js": "AtriumLandContours", [curves]: "AtriumGeometryCurves",
    "checks/connectivity.js": "AtriumConnectivity",
    "formats/altium-records.js": "AtriumAltiumRecords", "checks/altium-rules.js": "AtriumAltiumRules", "checks/design-query-record.js":"AtriumDesignQueryRecord", "pcb/designator-place.js": "AtriumDesignators",
    "pcb/diffpair.js": "AtriumDiffPair", "pcb/route-feel.js": "AtriumRouteFeel", "pcb/teardrops.js": "AtriumTeardrops", "analysis/impedance.js": "AtriumImpedance", "checks/drc.js": "AtriumDRC",
    "canvas/stroke-font.js": "AtriumStrokeFont", "pcb/pcb-pours.js": "AtriumPCBPours", "pcb/pour-marker.js": "AtriumPourMarker",
    "canvas/vectorize.js": "AtriumVectorize", "pcb/pcb-text-rich.js": "AtriumPCBTextRich", "pcb/mask-openings.js": "AtriumMaskOpenings",
    "pcb/stackup.js": "AtriumStackup", "pcb/viastack.js": "AtriumViaStack", "pcb/polygon-pour.js": "AtriumPolygonPour", "checks/rules.js": "AtriumRules", "pcb/rooms.js": "AtriumRooms", "pcb/component-classes.js": "AtriumComponentClasses", "pcb/pcb-draw.js": "AtriumPCBDraw", "pcb/pcb-text.js": "AtriumPCBText", "checks/z-clearance.js": "AtriumZClearance", "pcb/rigid-flex.js": "AtriumRigidFlex", "checks/flex-drc.js": "AtriumFlexDRC", "canvas/flex-fold.js": "AtriumFlexFold",
    "project/variants.js": "AtriumVariants", "schematic/multichannel.js": "AtriumMultichannel", "checks/query.js": "AtriumQuery", "checks/net-intent.js": "AtriumNetIntent", "checks/net-intent-index.js": "AtriumNetIntentIndex", "core/signals.js": "AtriumSignals", "project/doc-views.js": "AtriumDocViews",
    "ui/motion.js": "AtriumMotionUI", "ui/spatial-motion.js": "AtriumSpatialMotion"};
  globalThis.document = {
    documentElement: {dataset: {}},
    addEventListener() {},
    head: {append:attach},
    getElementById(id) {
      const slot = cascade.find(node => node.id === id);
      if (slot) return {before(node) {cascade.splice(cascade.indexOf(slot),1,node,slot); attach(node);}};
    },
    createElement: tag => ({tag, remove() { this.removed = true; }}),
    querySelectorAll: () => []
  };
  assert.equal(L.has("AtriumBOM"), false);
  assert.equal(D.performance,null);
  assert.equal(L.diagnosticAction("bom","pcb"),"manufacturing");
  assert.equal(L.diagnosticAction("drc","pcb"),"drc");
  assert.equal(L.diagnosticAction("review-changes","pcb"),"history");
  assert.equal(L.diagnosticAction("select","panel"),"panel");
  assert.equal(L.diagnosticAction("route","schematic"),"schematic");
  assert.equal(L.diagnosticAction("route","pcb"),"routing");
  assert.equal(L.diagnosticAction("view-3d","pcb"),"3d");
  assert.equal(L.diagnosticAction("drawing-text","drawing"),"drawing");
  assert.equal(L.diagnosticAction("panelize","pcb"),"panel");
  assert.equal(L.diagnosticAction("crash-diagnostics","pcb"),null);
  assert.equal(L.diagnosticAction("extension.example-private-id","private-doc-kind"),null);
  const session = D.startPerformance();
  const rows = () => D.performanceSnapshot().rows;
  const loadCounts = () => rows().find(row => row.component === "ui" && row.operation === "load").counts;
  const a = L.need("AtriumBOM"), b = L.need("AtriumBOM");
  assert.equal(L.pending("AtriumBOM"), true);
  await tick();
  assert.ok(globalThis.AtriumBOM && globalThis.AtriumVariants, "the real provider scripts completed");
  assert.equal(L.has("AtriumBOM"), false, "dependent actions stay gated while the provider stylesheet loads");
  assert.ok(variantSheet, "the first use requests the deferred stylesheet");
  variantSheet.onload();
  const [bom] = await Promise.all([a, b]);
  assert.equal(bom.from, "formats/bom.js");
  assert.deepEqual(appended, ["core/zip.js", "project/variants.js", "project/variants.css", "schematic/multichannel.js", "formats/bom.js", "formats/bom-optimiser.js", "ui/spreadsheet.css", "formats/bom.css", "formats/bom-optimiser.css"], "deps first, each file once, with CSS");
  assert.equal(L.pending("AtriumBOM"), false);
  assert.equal(L.has(["AtriumBOM", "AtriumZip"]), true);
  const bomLoad = loadCounts();
  assert.equal(bomLoad.started,4,"concurrent BOM requests share one load for each registered module");
  assert.equal(bomLoad.ready,bomLoad.started);
  assert.equal(bomLoad.completed,bomLoad.started);
  const constraintSheets = html.match(/AtriumLazy\.register\("AtriumConstraints",\{scripts:\["checks\/constraints\.js"\],css:(\[[^\]]+\])/);
  assert.ok(constraintSheets, "the Constraint Manager declares its CSS in index.html");
  const sheets = JSON.parse(constraintSheets[1]);
  assert.deepEqual(sheets, ["ui/spreadsheet.css", "checks/constraints.css"], "shared chrome comes before the surface overrides");
  L.register("AtriumConstraints", {scripts:["checks/constraints.js"], css:sheets});
  defines["checks/constraints.js"] = "AtriumConstraints";
  appended.length = 0;
  const passive = L.need("AtriumConstraints",{measure:false});
  assert.deepEqual(loadCounts(),bomLoad,"diagnostic demand is passive");
  await Promise.all([passive,L.need("AtriumConstraints"),L.need("AtriumConstraints")]);
  assert.deepEqual(appended, ["checks/constraints.js", "checks/constraints.css"], "opening Constraints reuses the already loaded BOM stylesheet");
  assert.equal(loadCounts().started,bomLoad.started+1,"ordinary demand can join a passive flight and counts it once");
  const afterConstraints = loadCounts();
  // Already loaded: nothing injected.
  appended.length = 0; await L.need("AtriumBOM"); assert.equal(appended.length, 0);
  assert.deepEqual(loadCounts(),afterConstraints,"cache hits record no load");
  const beforeRuntime = loadCounts();
  L.register("PassiveProvider",{scripts:["checks/passive-provider.js"]});
  defines["checks/passive-provider.js"] = "PassiveProvider";
  assert.equal((await L.need("PassiveProvider",{measure:false})).from,"checks/passive-provider.js");
  assert.deepEqual(loadCounts(),beforeRuntime,"an exclusively passive request does not create a load row");
  L.register("ExampleRuntimeProvider",{scripts:["checks/example-private-script.js"]},["extension.example-private-id"]);
  defines["checks/example-private-script.js"] = "ExampleRuntimeProvider";
  defines["canvas/input-diagnostics.js"] = "AtriumInputDiagnostics";
  await L.need("ExampleRuntimeProvider");
  const extensionCommand = AtriumKeymap.registerCommand({id:"extension.example-private-id", category:"Reports"});
  assert.equal(L.diagnosticAction("extension.example-private-id","pcb"),null);
  extensionCommand.dispose();
  assert.equal(loadCounts().started,beforeRuntime.started+1,"runtime provider contributes an anonymous aggregate load");
  const beforeDiagnostics = rows();
  await L.need("AtriumInputDiagnostics");
  assert.deepEqual(rows(),beforeDiagnostics,"diagnostics UI does not report its own load");
  assert.equal(JSON.stringify(rows()).includes("example-private"),false);
  appended.length = 0;
  // Aliases and dependencies across modules; a defined global is never injected again.
  globalThis.AtriumRouter = {eager: true};
  const [t, dp] = await L.need(["AtriumTeardrops", "AtriumDiffPair"]);
  assert.equal(t.from, "pcb/teardrops.js"); assert.equal(dp.from, "pcb/diffpair.js");
  assert.deepEqual(appended, [curves, "pcb/land-contours.js", "core/geometry.js", "ui/motion.js", "ui/spatial-motion.js", "ui/spatial-motion.css", "project/doc-views.js", "project/doc-views.css", "checks/net-intent.js", "checks/net-intent-index.js", "core/signals.js", "formats/altium-records.js", "checks/altium-rules.js", "checks/design-query-record.js", "analysis/impedance.js", "pcb/stackup.js", "pcb/stackup.css", "pcb/viastack.js", "pcb/viastack.css", "pcb/pcb-pours.js", "pcb/pour-marker.js", "pcb/polygon-pour.js", "pcb/polygon-pour.css", "pcb/rooms.js", "pcb/component-classes.js", "checks/rules.js", "checks/project-rules.js", "checks/drc-pours.js", "checks/creepage.js", "checks/rules-editor.css", "pcb/diffpair.js", "pcb/route-feel.js", "pcb/drag-reroute.js", "pcb/route-feel.css", "pcb/teardrops.js"],
    "the board core loads first; router.js was present, so only diffpair.js and route-feel.js load");
  assert.equal(globalThis.AtriumPourMarker.from, "pcb/pour-marker.js");
  assert.equal(globalThis.AtriumRouter.eager, true);
  // A failed load rejects, and a later need() retries.
  appended.length = 0; failNext = "checks/drc.js"; // impedance.js already came in with stackup.js
  await assert.rejects(L.need("AtriumDRC"), /Couldn't load checks\/drc\.js/);
  assert.equal(loadCounts().failed,1);
  await tick(); await tick();
  assert.equal(L.pending("AtriumDRC"), false);
  appended.length = 0;
  assert.equal((await L.need("AtriumDRC")).from, "checks/drc.js");
  assert.ok(appended.includes("checks/drc.js"), "retried");
  assert.equal(globalThis.AtriumDesignators?.from, "pcb/designator-place.js");
  assert.equal(globalThis.AtriumPCBTextRich?.from, "pcb/pcb-text-rich.js");
  assert.equal(globalThis.AtriumMaskOpenings?.from, "pcb/mask-openings.js");
  assert.ok(L.files().indexOf("pcb/designator-place.js") < L.files().indexOf("pcb/pcb-draw.js"), "board rendering loads authored designators first");
  await assert.rejects(L.need("AtriumNope"), /not available/);
  assert.equal(loadCounts().failed,1,"a successful retry preserves the earlier failure");
  session.stop();
  assert.equal(D.performance,null);
  // prefetch never throws and loads on idle.
  appended.length = 0; L.prefetch(["AtriumSwap", "AtriumNope"]); assert.equal(appended.length, 0, "nothing before idle");
  for (let i = 0; i < 20 && !appended.length; i++) await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(appended, ["library/component-swap.js"]);
  // Cancel queued preparation even if the host has already taken a stale callback out of its queue.
  const oldIdle = globalThis.AtriumIdle, idleWork = new Map();
  let idleSeq = 0, efficient = false;
  globalThis.AtriumIdle = {idle(fn) { idleWork.set(++idleSeq, fn); return idleSeq; }, cancel(id) { idleWork.delete(id); }};
  globalThis.AtriumPower = {visible: () => true, efficient: () => efficient};
  for (const [name, file] of [["AtriumHintOne", "hint-one.js"], ["AtriumHintTwo", "hint-two.js"]]) {
    L.register(name, {scripts: [file]}); defines[file] = name;
  }
  appended.length = 0;
  const withdrawn = L.prefetch("AtriumHintOne"), stale = idleWork.get(idleSeq);
  withdrawn(); stale();
  assert.equal(idleWork.size, 0); assert.deepEqual(appended, [], "leaving the control withdraws the pending hint");
  efficient = true;
  L.prefetch("AtriumHintOne");
  assert.equal(idleWork.size, 0, "no speculative load in Efficiency");
  efficient = false; globalThis.document.visibilityState = "hidden";
  L.prefetch("AtriumHintOne");
  assert.equal(idleWork.size, 0, "no hidden preparation");
  globalThis.document.visibilityState = "visible";
  L.prefetch(["AtriumHintOne", "AtriumHintTwo"]);
  const first = idleWork.get(idleSeq); idleWork.delete(idleSeq); first();
  efficient = true;
  await tick(); await tick();
  assert.deepEqual(appended, ["hint-one.js"], "entering Efficiency cancels the rest of a begun preparation");
  assert.equal(idleWork.size, 0);
  await L.need("AtriumHintTwo");
  assert.deepEqual(appended, ["hint-one.js", "hint-two.js"], "an explicit command still loads the identical feature");
  efficient = false; appended.length = 0;
  L.prefetch("AtriumMinimap"); L.cancelPrefetch();
  assert.equal(idleWork.size, 0, "a superseding edit cancels queued preparation");
  if (oldIdle) globalThis.AtriumIdle = oldIdle; else delete globalThis.AtriumIdle;
  // register() adds modules for other features.
  L.register("AtriumWidget", {scripts: ["widget.js"], css: ["widget.css"]}, ["widget"]);
  assert.deepEqual(L.forAction("widget", "pcb"), ["AtriumWidget"]);
  globalThis.AtriumPower = {visible: () => true, efficient: () => true};
  // The registered JS provider can also supply physical clearance rules. Only
  // the optional engine changes with visibility or an unavailable Wasm bridge.
  const required = L.forAction("repour", "schematic"), enabled = L.forAction("repour", "pcb");
  assert.ok(required.length && !required.includes("AtriumEngine"));
  assert.deepEqual(enabled, [...required, "AtriumEngine"], "an explicit repour can use the engine in Efficiency mode");
  globalThis.document.visibilityState = "hidden";
  const hidden = L.forAction("repour", "pcb");
  assert.deepEqual(hidden, required, "a hidden board requests exactly the mandatory JS providers");
  appended.length = 0;
  const kernels = await L.need(hidden);
  assert.deepEqual(kernels, required.map(n => globalThis[n]));
  assert.equal(globalThis.AtriumPolygonPour.from, "pcb/polygon-pour.js");
  assert.ok(!appended.includes("engine-core.js"), "executing the hidden command never starts Wasm");
  globalThis.document.visibilityState = "visible";
  failNext = "engine-core.js";
  assert.deepEqual(await L.need(L.forAction("repour", "pcb")), [...kernels, undefined], "an unavailable optional engine leaves every JS provider usable");
  assert.deepEqual(appended.filter(f => f === "engine-core.js"), ["engine-core.js"], "the visible command actually attempted the optional bridge once");
  assert.deepEqual(L.forAction("repour", "pcb"), required, "subsequent commands can run directly with JS");
  assert.deepEqual(await L.need(required), kernels);
  Object.assign(defines, {"history/history-artwork.js":"AtriumHistoryArtwork", "history/clip-history.js":"AtriumClipHistory",
    "history/undo-store.js":"AtriumUndoStore", "history/history-panel.js":"AtriumHistoryPanel", "checks/rule-groups.js":"AtriumRuleGroups"});
  appended.length = 0;
  await Promise.all([L.need("AtriumClipHistory"), L.need("AtriumHistoryPanel"), L.need("AtriumRuleGroups")]);
  assert.deepEqual(appended.filter(file=>file.endsWith(".css")), ["history/history-artwork.css", "ui/history-panels.css",
    "history/clip-history.css", "history/history-panel.css", "ui/rule-set-lists.css", "checks/rule-groups.css"]);
  assert.equal(L.has("AtriumMotionDiagnostics"), false, "the optional extension has not requested diagnostics");
  assert.ok(!appended.includes("editor/motion-service.js"));
  appended.length = 0;
  const diagnostics = await L.need("AtriumMotionDiagnostics");
  assert.deepEqual(appended.filter(file => motionProviders.has(file)), [...motionProviders],
    "the optional diagnostics service loads its motion, broker and catalogue providers first");
  assert.deepEqual(diagnostics.inspect("active", {}), {count: 0});
  assert.throws(() => diagnostics.inspect("unknown", {}), /Unknown motion diagnostic/);
  await L.need("AtriumMotionDiagnostics");
  assert.equal(appended.filter(file => file === "editor/motion-service.js").length, 1);
  // Both these features are requested after the variants sheet, which remains last in the cascade.
  Object.assign(defines, {"pcb/board-shape.js":"AtriumBoardShapeAuthoring", "pcb/board-shape-editing.js":"AtriumBoardShapeEditing",
    "pcb/board-shape-ui.js":"AtriumBoardShapeUI", "editor/messages.js":"AtriumMessages"});
  failedStyle = "pcb/board-shape.css";
  const [shape, messages] = await Promise.all([L.need("AtriumBoardShapeUI"), L.need("AtriumMessages")]);
  assert.equal(shape.from, "pcb/board-shape-ui.js", "a failed stylesheet keeps the feature available");
  assert.equal(messages.from, "editor/messages.js");
  assert.deepEqual(cascade.flatMap(node => node.href ? [node.href] : []), styledFeatures,
    "reverse and concurrent demand still inserts styles into their original positions");
  delete globalThis.AtriumPower;
  delete globalThis.document;
  console.log("lazy loader: registry, order, dedupe, CSS, retry and prefetch OK");
}
globalThis.__testDone = main();
globalThis.__testDone.catch(e => { console.error(e); if (typeof process !== "undefined") process.exitCode = 1; });
