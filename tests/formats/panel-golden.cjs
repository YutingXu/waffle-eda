"use strict";
// Golden self-regression of one panel's fabrication outputs (app/pcb/panel.js through fab-outputs.js).
// The panel: the sample board, 2 x 2, "Assembly frame, copper thieving" preset (5-sided frame of
// 7 mm rails, mouse-bite tabs, routing-bit fillets as exact arcs, copper thieving dots on every
// copper layer, fiducials, tooling holes, rail text), every other column turned 180° and one dragged tab.
// Every file of the panel ZIP is checked:
//   - every Gerber passes gerber-check (RS-274X/X2 structure) and parses (gerber-compare);
//   - the NC drills parse (Excellon) and hold exactly the panel's holes: per-board holes x 4, mouse
//     bites and tooling holes as NPTH;
//   - the profile (GM1) has arcs (G02/G03) for the fillets and spans the panel;
//   - the text equals tests/goldens/panel/ (dates normalised); big files by SHA-256 in manifest.json.
// Update after a deliberate change:  scripts/update-panel-goldens.sh   (then review git diff tests/goldens/panel)
// Run: scripts/test-jsc.sh panel-golden   (or node tests/formats/panel-golden.cjs); --emit prints the new goldens.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "spatial", "stackup", "pcb-pours", "pcb-appearance", "board-shape",
  "rigid-flex", "zip", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "bom", "source-file", "panel"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const {check: gerberCheck} = require("./gerber-check.cjs"), GC = require("./gerber-compare.cjs");
const P = AtriumPanel, F = AtriumFabOutputs, DIR = path.join(__dirname, "../goldens/panel"), EMIT = process.argv.includes("--emit");
const DATE = new Date(Date.UTC(2026, 5, 15, 12));
const normalise = text => text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, "<date>").replace(/\b\d{4}-\d\d-\d\d\b/g, "<date>")
  .replace(/^(Date:\s*)\d\d\/\d\d\/\d\d(\d\d)?/gm, "$1<date>").replace(/^(Time:\s*)\d\d:\d\d(:\d\d)?/gm, "$1<time>");
const sha = text => AtriumSourceFile.sha256(new TextEncoder().encode(text));
const HASH_ONLY = /\.GD1$|-Assembly-Top\.svg$/;   // large derived drawings: SHA-256 and size only

const p = AtriumParts.example(), b = p.documents.find(d => d.kind === "pcb");
const d = P.create(p, {board: b.id});
d.panel = P.applyPreset(d.panel, "assembly-frame");
d.panel = P.normalize({...d.panel, rows: 2, cols: 2, alternate: "cols", tabs: {...d.panel.tabs, manual: {"0,0:bottom": [.3, .7]}}});
p.documents.push(d);
const G = P.layout(p, d, null, {date: DATE}), out = P.build(p, d, {date: DATE});

// ---- structure (independent of the goldens) ----------------------------------------------
const one = F.build(p, b.id, {date: DATE}), file = (r, re) => r.files.find(f => re.test(f.name));
for (const f of out.files.filter(f => f.kind === "gerber")) {
  assert.deepEqual(gerberCheck(f.content).issues, [], f.name);
  const g = GC.parseGerber(f.content);
  assert.ok(g && (g.flashes?.length || g.draws?.length || g.regions?.length || g.segments?.length || Object.keys(g).length), f.name + " parses");
}
const drills = r => ["Plated", "NonPlated"].map(k => { const x = file(r, new RegExp("-" + k + "\\.TXT$")); return x ? GC.parseExcellon(x.content) : null; });
const [pth, npth] = drills(out), [pth1, npth1] = drills(one);
const hitsOf = x => x ? (x.hits || x.holes || []).length : 0;
assert.equal(hitsOf(pth), 4 * hitsOf(pth1), "plated holes repeated per instance");
assert.equal(hitsOf(npth), 4 * hitsOf(npth1) + G.bites.length + G.tooling.length, "NPTH: boards x 4, mouse bites and tooling holes");
const gm1 = file(out, /\.GM1$/).content;
// The drill map and assembly drawing include the routed openings between panel tabs.
// The production milling Gerber is the independent reference for each positioned stroke.
const drillMap = GC.parseGerber(file(out, /\.GD1$/).content), profile = GC.parseGerber(gm1);
const geometry = draw => JSON.stringify([draw.points, !!draw.arc]);
const drawingStrokes = new Map();
for (const draw of drillMap.draws) {
  const key = geometry(draw);
  drawingStrokes.set(key, (drawingStrokes.get(key) || 0) + 1);
}
for (const draw of profile.draws) {
  const key = geometry(draw), left = drawingStrokes.get(key) || 0;
  assert.ok(left > 0, "drill drawing contains each physical profile stroke and fillet");
  drawingStrokes.set(key, left - 1);
}
const outlines = [...G.profile.segs.outer, ...G.profile.segs.holes, ...G.profile.cutouts];
const boardPath = /<g id="board-outline"[^>]*><path d="([^"]+)" fill-rule="evenodd"/.exec(file(out, /-Assembly-Top\.svg$/).content)?.[1];
assert.ok(boardPath, "assembly drawing has a cutout-aware board outline");
assert.equal((boardPath.match(/M/g) || []).length, outlines.length, "every machining loop starts a closed subpath");
assert.equal((boardPath.match(/Z/g) || []).length, outlines.length, "every machining subpath closes");
assert.equal((boardPath.match(/A/g) || []).length, outlines.reduce((n,c) => n + c.filter(s => s.kind === "arc").length, 0), "assembly drawing preserves every routing fillet");

assert.match(gm1, /%TF\.FileFunction,Profile,NP\*%/);
assert.match(gm1, /G0[23]\*?/, "fillet arcs reach the profile");
const xs = [...gm1.matchAll(/X(-?\d+)Y(-?\d+)D0[12]/g)].map(m => [+m[1] / 1e6, +m[2] / 1e6]);
assert.ok(Math.abs(Math.max(...xs.map(q => q[0])) - G.W) < 1e-3 && Math.abs(Math.max(...xs.map(q => q[1])) - G.H) < 1e-3, "profile spans the panel");
assert.ok(G.thieving.dots.length > 50, "thieving dots");
assert.match(file(out, /\.GTL$/).content, /%TA\.AperFunction,NonConductor\*%/, "thieving is non-conductor copper");
assert.equal(G.instances.map(i => i.rotation).join(), "0,180,0,180", "alternate columns");
assert.ok(G.tabs.some(t => t.manual && t.key === "0,0:bottom"), "the dragged tabs");
const pnp = file(out, /^Pick Place/).content;
for (const k of [1, 2, 3, 4]) assert.ok(pnp.includes("\"R1_" + k + "\""), "R1_" + k);
assert.match(file(out, /-Panel-Drawing\.svg$/).content, /^<\?xml[\s\S]*<svg [\s\S]*Copper thieving[\s\S]*<\/svg>\n$/);

// ---- goldens -----------------------------------------------------------------------------
const manifest = {}, texts = {};
for (const f of out.files) {
  const text = normalise(typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content));
  manifest[f.name] = {sha256: sha(text), bytes: text.length, lines: text.split("\n").length};
  if (!HASH_ONLY.test(f.name)) texts[f.name] = text;
}
if (EMIT) {
  console.log("@@@FILE manifest.json"); console.log(JSON.stringify(manifest, null, 1)); console.log("@@@END");
  for (const [name, text] of Object.entries(texts)) { console.log("@@@FILE " + name); console.log(text); console.log("@@@END"); }
} else {
  const golden = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")), problems = [];
  for (const name of new Set([...Object.keys(golden), ...Object.keys(manifest)])) {
    if (!golden[name]) { problems.push("new output " + name); continue; }
    if (!manifest[name]) { problems.push("output no longer written: " + name); continue; }
    if (golden[name].sha256 === manifest[name].sha256) continue;
    let detail = " (" + golden[name].bytes + " -> " + manifest[name].bytes + " bytes)";
    if (texts[name] != null && fs.existsSync(path.join(DIR, name))) {
      const old = fs.readFileSync(path.join(DIR, name), "utf8").split("\n"), now = texts[name].split("\n"), i = now.findIndex((l, k) => l !== old[k]);
      detail += ", line " + (i < 0 ? old.length + 1 : i + 1) + ": " + JSON.stringify((old[i < 0 ? old.length : i] ?? "").slice(0, 80)) + " -> " + JSON.stringify((now[i < 0 ? old.length : i] ?? "").slice(0, 80));
    }
    problems.push(name + " changed" + detail);
  }
  assert.deepEqual(problems, [], "Panel outputs differ from tests/goldens/panel. If intended, run scripts/update-panel-goldens.sh and review the diff:\n  " + problems.join("\n  "));
  console.log("panel-golden: " + Object.keys(manifest).length + " files match tests/goldens/panel");
}
