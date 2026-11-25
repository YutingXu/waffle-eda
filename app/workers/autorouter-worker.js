"use strict";
// Dedicated worker for the autorouter when Blob workers are not permitted.
// The editor normally embeds the router and geometry into a Blob Worker.
// This file loads the same source modules when that path is blocked.
globalThis.AtriumAutorouterWorker = true;
importScripts("../core/geometry.js", "../pcb/autorouter.js");
