// Command-line SPICE runner over AtriumSpice (no editor, no DOM).
//   node extensions/spice/cli.js deck.cir [--csv] [--probe out,in]
//   jsc extensions/spice/expr.js extensions/spice/spice.js extensions/spice/cli.js -- deck.cir [--csv]
// Runs the deck's first analysis card (.op by default) and prints JSON, or CSV with --csv.
(function () {
  const node = typeof process === "object" && process.versions && process.versions.node;
  const S = node ? require("./spice.js") : globalThis.AtriumSpice;
  const argv = node ? process.argv.slice(2) : Array.from(globalThis.scriptArgs || globalThis.arguments || []);
  const out = t => (node ? process.stdout.write(t + "\n") : globalThis.print(t));
  const file = argv.find(a => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--probe");
  if (!S || !file) { out("usage: cli.js deck.cir [--csv] [--probe net,net]"); return; }
  const text = node ? require("node:fs").readFileSync(file, "utf8") : globalThis.readFile(file);
  const pi = argv.indexOf("--probe"), probes = pi >= 0 ? String(argv[pi + 1] || "").split(",").filter(Boolean) : null;
  const r = S.simulate(text, undefined, {missing: "skip"});
  if (r.type === "op") { out(JSON.stringify({nodes: r.nodes, currents: r.currents, devices: r.devices, warnings: r.warnings}, null, 1)); return; }
  const sigs = probes ? probes.map(p => S.signal(r, p)).filter(Boolean) : r.signals;
  if (argv.includes("--csv")) {
    const cols = sigs.map(s => (r.type === "ac" ? [S.db(s), S.phase(s)] : [s.re])).flat();
    out([r.xName, ...sigs.map(s => (r.type === "ac" ? [s.name + " dB", s.name + " deg"] : [s.name])).flat()].join(","));
    r.x.forEach((x, i) => out([x, ...cols.map(c => c[i])].join(",")));
  } else out(JSON.stringify({analysis: r.analysis, x: r.x, signals: Object.fromEntries(sigs.map(s => [s.name, r.type === "ac" ? {db: S.db(s), phase: S.phase(s)} : s.re])), warnings: r.warnings, stats: r.stats}));
})();
