"use strict";
// Dedicated worker for the 2D transmission-line field solver when Blob workers are not
// permitted. AtriumFieldSolver.async() normally starts the solver from a Blob built from
// AtriumFieldSolverFactory itself (which also works from file://); this file is the fallback.
// Messages: {type:"solve", id, geom, opts} -> {type:"result", id, result}.
importScripts("../analysis/field-solver.js");
AtriumFieldSolverServe(self, AtriumFieldSolver);
