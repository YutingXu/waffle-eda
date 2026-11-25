"use strict";
// Dedicated worker for the PDN solver when Blob workers are not permitted. pdn.js normally
// starts the solver from a Blob built from AtriumPDNCore itself, which also works from
// file://; this file is the fallback.
importScripts("../analysis/electrical-material.js", "../analysis/pdn.js");
AtriumPDNServe(self, AtriumPDNCore());
