"use strict";

// Standalone online checks use the resolved-board runtime normally loaded by the editor.
const {appFile} = require("./app-source-paths.cjs");
for (const name of ["pcb-appearance","stroke-font","vectorize","pcb-text-rich","pcb-text","designator-place",
  "pcb-draw","pcb-pours","board-shape","stackup","viastack","polygon-pour",
  "pcb/resolved-geometry-curves","pcb/geometry-material","pcb/mask-openings","pcb/resolved-geometry"])
  require(appFile(name + ".js"));
