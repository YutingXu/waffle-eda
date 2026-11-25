"use strict";
// Dedicated worker for the temperature-rise solver when Blob workers are not permitted. thermal.js
// normally starts the solver from a Blob built from AtriumPDNCore and AtriumThermalCore, which also
// works from file://; this file is the fallback.
importScripts("../analysis/electrical-material.js", "../analysis/pdn.js", "../analysis/thermal.js");
AtriumPDNServe(self, AtriumThermalCore(AtriumPDNCore()));
