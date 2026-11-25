"use strict";

const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const fixtures = path.resolve(__dirname, "../fixtures");
const altium = "altium/pidp11-io-expander/";
const pidp = altium + "PiDP11IOExpander.";
const formats = [
  "altium-schdoc", "altium-pcbdoc", "altium-schlib", "altium-pcblib", "altium-project",
  "kicad-board", "kicad-sheet", "kicad-project", "kicad-symbol", "kicad-footprint",
  "eagle-board", "eagle-sheet", "easyeda-board", "easyeda-sheet", "easyeda-pro", "easyeda-epcb", "easyeda-esch",
  "ipc2581", "gerber", "excellon", "step", "step-reference", "odb"
];
const modes = ["original", "variation", "truncated", "missing"];
const bytes = name => fs.readFileSync(path.join(fixtures, name));
const file = (name, data) => ({name: path.basename(name), bytes: Buffer.from(data)});

function random(seed, format, round) {
  let state = (seed + Math.imul(round, 2654435761)) >>> 0;
  for (const c of format) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  return n => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 4294967296 * n);
  };
}
function prefix(data, rand) {
  return data.subarray(0, 1 + rand(data.length - 1));
}
function framed(value) {
  const data = Buffer.from(value), header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
function propertyRecord(s) { return framed(Buffer.from(s + "\0", "latin1")); }
function compound(entries) {
  const c = CFB.utils.cfb_new();
  for (const [name, data] of entries) CFB.utils.cfb_add(c, name, data);
  return Buffer.from(CFB.write(c, {type: "buffer"}));
}
function replaceStream(c, stream, transform) {
  const index = c.FullPaths.findIndex(name => name.toLowerCase().endsWith("/" + stream.toLowerCase()));
  assert.ok(index >= 0, stream);
  const e = c.FileIndex[index];
  e.content = transform(Buffer.from(e.content));
  e.size = e.content.length;
}
function altiumInput(format, mode, rand) {
  const suffix = { "altium-schdoc": "SchDoc", "altium-pcbdoc": "PcbDoc", "altium-schlib": "SchLib", "altium-pcblib": "PcbLib" }[format];
  let data, name;
  const short = b => b.subarray(0, b.length - 1 - rand(Math.min(7, b.length - 1)));
  const variant = mode === "variation", missing = mode === "missing";
  if (suffix === "SchDoc" || suffix === "PcbDoc") {
    name = pidp + suffix;
    data = bytes(name);
    if (variant || missing) {
      const c = CFB.read(data, {type: "buffer"});
      if (suffix === "SchDoc") {
        replaceStream(c, "FileHeader", b => missing ? short(b) : Buffer.concat([b,
          propertyRecord("|RECORD=4|OWNERINDEX=-1|TEXT=Sheet " + rand(10000) + "|LOCATION.X=100|LOCATION.Y=200")]));
      } else {
        replaceStream(c, "Tracks6/Data", b => {
          if (missing) return short(b);
          assert.equal(b[0], 4);
          // Move the first track's start by a small number of native units.
          b.writeInt32LE(b.readInt32LE(18) + 100 + rand(10000), 18);
          return b;
        });
      }
      data = CFB.write(c, {type: "buffer"});
    }
  } else if (suffix === "SchLib") {
    name = "Lab.SchLib";
    const lines = bytes("library/" + name).toString("latin1").trim().split(/\r?\n/);
    const end = lines.findIndex((s, i) => i > 1 && s.startsWith("|RECORD=1|"));
    const label = variant ? "SampleAmp" + rand(10000) : "LMV321";
    const records = Buffer.concat(lines.slice(1, end).map(s => propertyRecord(s.replaceAll("LMV321", label))));
    data = compound([["FileHeader", propertyRecord(lines[0])], [label + "/Data", missing ? short(records) : records]]);
  } else {
    name = "Pad.PcbLib";
    // Build an OLE footprint library from one complete pad in the BSD-2 board.
    const c = CFB.read(bytes(pidp + "PcbDoc"), {type: "buffer"});
    const pads = Buffer.from(CFB.find(c, "/Pads6/Data").content);
    const chosen = variant ? 1 + rand(4) : 0;
    let start = 0, end = 0;
    for (let i = 0; i <= chosen; i++) {
      start = end;
      assert.equal(pads[end++], 2);
      for (let block = 0; block < 6; block++) end += 4 + pads.readUInt32LE(end);
    }
    const label = Buffer.from("SamplePad");
    const stream = Buffer.concat([framed(Buffer.concat([Buffer.from([label.length]), label])), pads.subarray(start, end)]);
    data = compound([["SamplePad/Parameters", propertyRecord("|PATTERN=SamplePad")], ["SamplePad/Data", missing ? short(stream) : stream]]);
  }
  if (mode === "truncated") data = prefix(data, rand);
  assert.ok(mode === "truncated" || Buffer.from(data).subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")));
  return [file(name, data)];
}

const singles = {
  "kicad-board": ["import/demo.kicad_pcb", '"SIG"', '"Signal @@"'],
  "kicad-sheet": ["import/root.kicad_sch", '"10k"', '"@@k"'],
  "kicad-symbol": ["kicad/Lab_Amp.kicad_sym", "Hand-made dual op-amp for tests", "Bench amplifier @@"],
  "kicad-footprint": ["kicad/Lab_Package.pretty/R_0603_Test.kicad_mod", "(offset (xyz 0 0 0))", "(offset (xyz @@ 0 0))"],
  "eagle-board": ["import/demo-eagle.brd", 'name="SIG"', 'name="Signal @@"'],
  "eagle-sheet": ["import/demo-eagle.sch", 'value="10k"', 'value="@@k"']
};
function textMutation(data, mode, rand, change) {
  if (mode === "truncated") return prefix(data, rand);
  if (mode === "original") return data;
  const text = data.toString("utf8");
  if (mode === "variation") {
    const changed = change(text);
    assert.notEqual(changed, text, "structure-aware edit changed a field");
    return Buffer.from(changed);
  }
  // A lost source line, as in an interrupted editor save.
  const lines = text.split(/\r?\n/);
  lines.splice(rand(lines.length - 1), 1);
  return Buffer.from(lines.join("\n"));
}
function build(format, mode, seed, round) {
  const rand = random(seed, format, round), n = 1 + rand(99);
  if (format === "altium-project") {
    const name = altium + "PCB-PiDP11IOExpander.PrjPcb";
    const data = textMutation(bytes(name), mode, rand, s => s + "\r\n[Parameter89]\r\nName=Sample\r\nValue=" + n + "\r\n");
    return [file(name, data), file(pidp + "SchDoc", bytes(pidp + "SchDoc"))];
  }
  if (format.startsWith("altium-")) return altiumInput(format, mode, rand);
  if (singles[format]) {
    const [name, old, replacement] = singles[format];
    return [file(name, textMutation(bytes(name), mode, rand, s => s.replaceAll(old, replacement.replace("@@", n))))];
  }
  if (format === "kicad-project") {
    const name = "import/demo.kicad_pro";
    const data = textMutation(bytes(name), mode, rand, s => {
      const p = JSON.parse(s);
      p.net_settings.classes[0].clearance = n / 100;
      return JSON.stringify(p);
    });
    return [file(name, data), ...["demo.kicad_pcb", "root.kicad_sch", "child.kicad_sch"].map(name => file(name, bytes("import/" + name)))];
  }
  if (format === "easyeda-board" || format === "easyeda-sheet") {
    const name = "import/demo-easyeda-" + (format === "easyeda-board" ? "pcb" : "sch") + ".json";
    const data = textMutation(bytes(name), mode, rand, s => {
      const p = JSON.parse(s);
      p.shape = p.shape.map(row => row.replaceAll("~SIG~", "~SIG" + n + "~"));
      return JSON.stringify(p);
    });
    return [file(name, data)];
  }
  if (format.startsWith("easyeda-")) {
    const archive = bytes("import/demo-easyeda.epro");
    if (format === "easyeda-pro" && mode !== "variation" && mode !== "missing") {
      return [file("Demo.epro", mode === "truncated" ? prefix(archive, rand) : archive)];
    }
    const entries = AtriumImportFormats.unzip(archive);
    const isBoard = format !== "easyeda-esch", inner = isBoard ? "PCB/board1.epcb" : "SHEET/s1/1.esch";
    const data = textMutation(Buffer.from(entries.get(inner)), mode, rand, s => s.replaceAll('"SIG"', '"SIG' + n + '"'));
    if (format !== "easyeda-pro") return [file(inner, data)];
    entries.set(inner, data);
    return [file("Demo.epro", AtriumZip.create(Array.from(entries, ([name, data]) => ({name, data})), {date: new Date(2000, 0, 1)}))];
  }
  if (format === "step-reference") {
    const name = "kicad/Lab_Package.pretty/R_0603_Test.kicad_mod", source = bytes(name).toString();
    const ref = {original: "R_0603_Test.wrl", variation: "Part" + n + ".stp", truncated: "", missing: "Missing" + n + ".step"}[mode];
    return [file(name, source.replace("R_0603_Test.wrl", ref))];
  }
  if (format === "step") {
    const name = "mcad/tray.step";
    const data = textMutation(bytes(name), mode, rand, s => s.replace(/CARTESIAN_POINT\('',\(([^,]+),/, (_, x) => "CARTESIAN_POINT('',(" + (+x + n / 100).toFixed(4) + ","));
    return [file(name, data)];
  }
  if (format === "ipc2581") {
    const project = AtriumParts.example(), doc = project.documents.find(d => d.kind === "pcb");
    const source = AtriumIPC2581.build(project, doc, {date: new Date(2000, 0, 1)}).content;
    const data = mode === "missing" ? Buffer.from(source.replace(/<LayerRef name="[^"]+"/, "<LayerRef")) :
      textMutation(Buffer.from(source), mode, rand, s => s.replaceAll('"TOP"', '"TOP_' + n + '"').replaceAll('side="TOP_' + n + '"', 'side="TOP"'));
    return [file("Sample.ipc2581.xml", data)];
  }
  if (format === "gerber" || format === "excellon") {
    const isGerber = format === "gerber", ext = isGerber ? "GTL" : "TXT";
    const name = altium + "altium-outputs-reva/PiDP11IOExpander." + ext;
    const data = textMutation(bytes(name), mode, rand, s => s.replace(/^X(\d+)/m, (_, x) => "X" + String(+x + n).padStart(x.length, "0")));
    return [file(name, data)];
  }
  assert.equal(format, "odb");
  // An ordinary ODB++ job selection. The application currently has no ODB++ reader.
  const entries = [{name: "sample/matrix/matrix", data: "STEP {\nCOL=1\nNAME=board\n}\n"},
    {name: "sample/steps/board/profile", data: "UNITS=MM\nOB 0 0 I\nOS 10 0\nOS 10 10\nOS 0 0\nOE\n"}];
  if (mode === "variation") entries[1].data = entries[1].data.replaceAll("10", String(n));
  if (mode === "missing") entries.pop();
  const archive = Buffer.from(AtriumZip.create(entries, {date: new Date(2000, 0, 1)}));
  return [file("sample-odb.zip", mode === "truncated" ? prefix(archive, rand) : archive)];
}
module.exports = {formats, modes, build, bytes};
