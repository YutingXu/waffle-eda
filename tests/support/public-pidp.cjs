"use strict";
const fs = require("node:fs"), path = require("node:path");

// Start routing and performance checks from the original public Altium schematic and board.
function publicPiDP(app = path.join(__dirname, "..", "..", "app")) {
  globalThis.CFB = require(path.join(app, "vendor", "cfb.min.js"));
  for (const module of ["model","board-shape","source-file","altium-ids","altium-rules","sch-import","pcb-import","sexpr","io"]) {
    require(require("./app-source-paths.cjs").appFileFrom(app, module + ".js"));
  }
  const directory = path.join(__dirname, "..", "fixtures", "altium", "pidp11-io-expander");
  const project = Atrium.project("PiDP-11 I/O Expander");
  project.documents = [];
  for (const name of ["PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
    const imported = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(directory,name))));
    project.documents.push(...imported.documents);
    project.library.push(...imported.library);
  }
  return project;
}
module.exports = {publicPiDP};
