"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "spatial", "source-file", "pcb-pours", "pcb-import", "io", "board-shape","board-shape-sources", "import-link",
  "import-worker-client", "pcb-appearance", "stackup", "rules", "polygon-pour", "fab-outputs", "output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {parseGerber} = require("./gerber-compare.cjs");
const A = Atrium, F = AtriumFabOutputs, J = AtriumOutputJobs, date = new Date("2026-01-01T00:00:00Z");
const bytes = value => new TextEncoder().encode(value);
const settings = "|GerberUnit=Metric|NumberOfDecimals=4|OriginPosition=Absolute|Plot.Set=SerializeLayerHash.Version~2,16973837~1";
const row = "Configuration1_Item1=Record=GerberView";
const outline = "|RECORD=Board|VX0=0mm|VY0=0mm|VX1=8mm|VY1=0mm|VX2=10mm|VY2=2mm|VX3=10mm|VY3=8mm|VX4=0mm|VY4=8mm" +
  "|KIND1=1|CX1=8mm|CY1=2mm|SA1=270|EA1=360";
const track = ([x1, y1], [x2, y2]) => `|RECORD=Track|LAYER=KEEPOUT|X1=${x1}mm|Y1=${y1}mm|X2=${x2}mm|Y2=${y2}mm|WIDTH=10mil`;
const art = [track([0, 0], [8, 0]), track([10, 2], [10, 8]), track([10, 8], [0, 8]), track([0, 8], [0, 0]),
  "|RECORD=Arc|LAYER=KEEPOUT|LOCATIONX=8mm|LOCATIONY=2mm|RADIUS=2mm|STARTANGLE=270|ENDANGLE=360|WIDTH=10mil"];
const boardFile = (items = art, board = outline) => bytes([board, ...items].join("\r\n"));
function imported(pcb, config, name = "Board.PcbDoc") {
  const files = [{name: "Board.PrjPcb", bytes: bytes(`[Document1]\nDocumentPath=${name}\n[OutputGroup1]\n${config}`)}, {name, bytes: pcb}];
  const all = files.map(f => AtriumIO.read(f.name, f.bytes));
  const p = AtriumImport.assemble(all, files, A.project("Before"), null).after;
  return A.validate(JSON.parse(JSON.stringify(p)));
}

const source = imported(boardFile(), row + settings);
const [job] = source.outputJobs;
assert.deepEqual(job.outputs[0].options, {units: "mm", origin: "absolute", format: "4:4", profileWidth: .254,
  profileOnly: true, layers: {GM1: false, GKO: true}, drill: false, readme: false});
assert.ok(source.importNotes.some(line => line.includes("Saved an Altium board profile job")));
const run = J.run(source, job.name, {date});
assert.equal(run.report.ok, true);
assert.equal(run.files.length, 1);
assert.match(run.files[0].name, /\.GKO$/);
const content = new TextDecoder().decode(run.files[0].data);
assert.match(content, /%FSLAX44Y44\*%/);
const plot = parseGerber(content);
assert.equal(plot.draws.filter(d => d.arc).length, 1);
assert.ok(plot.draws.every(d => d.width === .254));

// All of these use the normal explicit-width output settings instead of
// adopting a layer that may do something different in the source job.
const inaccurate = [art[0].replace("Y2=0mm", "Y2=0.04mm"), ...art.slice(1)];
const alteredArc = [...art.slice(0, 4), art[4].replace("STARTANGLE=270|ENDANGLE=360", "STARTANGLE=0|ENDANGLE=270")];
const controls = [
  [boardFile([...art, track([.04, .04], [8.04, .04])]), row + settings],
  [boardFile(inaccurate), row + settings], [boardFile(alteredArc), row + settings],
  [boardFile(art.map((line, i) => i ? line : line.replace("10mil", "11mil"))), row + settings],
  [boardFile(), row + settings + "|PlotBoardProfile=True"],
  [boardFile(), row + settings + "|DocumentPath=SomeOtherBoard.PcbDoc"],
  [boardFile(), row + settings + "|Mirror.Set=16973837~1"],
  [boardFile(), row + settings + "|OutputFormat=Single"],
  [boardFile(), row + settings + "\n" + row.replace("Configuration1_", "Configuration2_") + settings],
  [boardFile(), row + settings.replace("Absolute", "Relative")],
];
for (const [pcb, config] of controls) assert.equal(imported(pcb, config).outputJobs, undefined);
const ordinary = F.build(source, job.board, {date});
assert.equal(ordinary.options.profileWidth, .1);
assert.equal(ordinary.files.some(f => f.name.endsWith(".GKO")), false);

const pi = "PiDP11IOExpander.PcbDoc", piPath = path.join(__dirname, "../fixtures/altium/pidp11-io-expander", pi);
const piSource = imported(new Uint8Array(fs.readFileSync(piPath)),
  row + "|GerberUnit=Imperial|NumberOfDecimals=5|OriginPosition=Relative|Plot.Set=16908289~1|DocumentPath=[PCB Document]", pi);
const [piJob] = piSource.outputJobs;
assert.ok(Math.abs(piJob.outputs[0].options.profileWidth - .1) < 1e-6);
const piRun = J.run(piSource, piJob.name, {date});
assert.equal(piRun.report.ok, true, JSON.stringify(piRun.report));
assert.equal(piRun.files.length, 1);
assert.match(piRun.files[0].name, /\.GM1$/);
const piPlot = new TextDecoder().decode(piRun.files[0].data);
assert.match(piPlot, /%FSLAX25Y25\*%/);
assert.ok(Math.abs(parseGerber(piPlot).draws[0].width - piJob.outputs[0].options.profileWidth) < 1e-8);

console.log("PASS saved Altium profile jobs use exactly selected layers, pen widths, arcs and coordinate formats");
