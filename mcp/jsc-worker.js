"use strict";
// Engine worker for the MCP server on macOS (board_runner.py, backend "jsc-cli").
//
// JavaScriptCore contexts that a process creates through the C API run without the JIT on
// current macOS (about 5x slower on DRC and connectivity); the system `jsc` helper
// (JavaScriptCore.framework/Helpers/jsc) has it. This script runs inside that helper and
// serves the same calls as the in-process context: AtriumHeadless and AtriumBoardReport over
// the same app modules, with the same arguments and results.
//
// Protocol: one JSON line per call on stdin,
//   {"modules": [file, ...], "entry": "AtriumHeadless", "parts": [file, ...], "out": file}
// The first frame also carries an OS entropy seed for UUIDv7 generation.
// The worker loads modules it has not loaded yet (in order, once each, into the global scope
// as JSEvaluateScript does), reads each part file as UTF-8 text, calls entry(...parts) and
// writes {"text": result} or {"error": message} to `out` as JSON (lone surrogates stay
// escaped, so the server reads back exactly the string the call returned), then prints one
// line. The server writes and removes the files in a private folder, and kills the process at
// the call's time or memory limit. No design data is ever evaluated as code.
(() => {
  const loaded = new Set();
  for (;;) {
    const line = readline();
    if (line == null || line === "") return;
    let request = null, reply;
    try {
      request = JSON.parse(line);
      if (request.uuidSeed) globalThis.__waffleUUIDSeed = request.uuidSeed;
      for (const file of request.modules) if (!loaded.has(file)) { load(file); loaded.add(file); }
      const fn = globalThis[request.entry];
      if (typeof fn !== "function") throw Error(request.entry + " is not available.");
      const args = request.parts.map(file => readFile(file));
      const large = args.reduce((n, s) => n + s.length, 0) >= 1048576;
      reply = JSON.stringify({text: String(fn(...args))});
      args.length = 0;
      if (large) gc();
    } catch (error) {
      reply = JSON.stringify({error: error && error.message ? error.message : String(error)});
    }
    if (request && typeof request.out === "string") writeFile(request.out, reply);
    print("done");
  }
})();
