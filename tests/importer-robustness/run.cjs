"use strict";

const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const {Worker, isMainThread, parentPort, workerData} = require("node:worker_threads");
const {once} = require("node:events");
const {formats, modes} = require("./corpus.cjs");
const {writeSync} = require("node:fs");
const MiB = 1048576, DEFAULT_SEED = 0x57414646;
const generatedLimits = {input: 4 * MiB, rss: 256 * MiB, heap: 96, deadline: 5000};
const publicLimits = {input: 24 * MiB, rss: 512 * MiB, heap: 192, deadline: 15000};
const peakBytes = () => process.resourceUsage().maxRSS * 1024;

if (!isMainThread) {
  // Independent of the parser's event loop. The OS high-water mark also
  // accounts for transient peaks, ArrayBuffers and the actual browser worker.
  setInterval(() => {
    if (peakBytes() > workerData.rss) {
      writeSync(2, "Importer case exceeded the " + workerData.rss / MiB + " MiB resident-memory limit.\n");
      process.kill(process.pid, "SIGKILL");
    }
  }, 20);
  parentPort.postMessage("ready");
} else if (require.main === module) {
  (async () => {
    const spec = JSON.parse(process.argv[2]), limits = spec.source ? publicLimits : generatedLimits;
    const guard = new Worker(__filename, {workerData: {rss: limits.rss}});
    try {
      await once(guard, "message");
      const status = await require("./case.cjs").run(spec, limits.input);
      const peak = peakBytes();
      assert.ok(peak <= limits.rss, "case exceeded the resident-memory limit");
      console.log(JSON.stringify({status, peak}));
    } finally {
      await guard.terminate();
    }
  })().catch(err => { console.error(err); process.exitCode = 1; });
}

function supervise(spec, replay) {
  const started = Date.now(), limits = spec.source ? publicLimits : generatedLimits;
  const p = spawnSync(process.execPath, ["--max-old-space-size=" + limits.heap, __filename, JSON.stringify(spec)],
    {timeout: limits.deadline, killSignal: "SIGKILL", maxBuffer: 16 * 1024, encoding: "utf8", env: {...process.env, TZ: "UTC"}});
  if (p.status !== 0 || p.error) throw Error(replay + "\n" + (p.error?.message || p.signal || "") + "\n" + p.stderr + p.stdout);
  const result = JSON.parse(p.stdout);
  assert.ok(["accepted", "rejected", "unresolved", "unsupported"].includes(result.status) && result.peak > 0 && result.peak <= limits.rss, replay);
  return {...result, elapsed: Date.now() - started};
}

function publicCorpus() {
  const manifest = spawnSync("python3", ["-B", require("node:path").join(__dirname, "public.py")], {encoding: "utf8"});
  if (manifest.status !== 0 || manifest.error) throw Error(manifest.error?.message || manifest.stderr);
  let accepted = 0, maxPeak = 0, maxMs = 0;
  for (const source of JSON.parse(manifest.stdout)) {
    const label = source.project + "/" + source.name;
    const result = supervise({format: "altium-" + source.suffix, mode: "original", source}, label);
    assert.equal(result.status, "accepted", label);
    maxPeak = Math.max(maxPeak, result.peak);
    maxMs = Math.max(maxMs, result.elapsed);
    accepted++; console.log("Accepted " + label);
  }
  assert.ok(accepted > 0);
  console.log("Public documents: " + accepted + " accepted, peak " + (maxPeak / MiB).toFixed(1) + " MiB, longest " + maxMs + " ms.");
}

function run(args) {
  if (args.length === 1 && args[0] === "--public") return publicCorpus();
  const options = {seed: DEFAULT_SEED, long: false, round: null, format: null, mode: null};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--long") options.long = true;
    else if (["--format", "--mode", "--round", "--seed"].includes(arg) && i + 1 < args.length) {
      options[arg.slice(2)] = ["--round", "--seed"].includes(arg) ? Number(args[++i]) : args[++i];
    } else throw Error("Unknown or incomplete importer test option: " + arg);
  }
  assert.ok(Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff, "--seed is a 32-bit unsigned integer");
  assert.ok(options.round === null || Number.isInteger(options.round) && options.round >= 0 && options.round < 65536, "invalid round");
  assert.ok(!options.format || formats.includes(options.format), "unknown importer format");
  assert.ok(!options.mode || modes.includes(options.mode), "unknown case mode");
  const numRounds = options.round !== null ? 1 : options.long ? 12 : 1;
  let total = 0, maxPeak = 0, maxMs = 0;
  for (const format of options.format ? [options.format] : formats) {
    const counts = {};
    for (let i = 0; i < numRounds; i++) for (const mode of options.mode ? [options.mode] : modes) {
      if (i > 0 && mode === "original") continue;
      const round = options.round ?? i, seed = options.seed;
      const replay = "node tests/formats/importer-robustness.cjs --seed " + seed + " --format " + format + " --mode " + mode + " --round " + round;
      const {status, peak, elapsed} = supervise({format, mode, seed, round}, replay);
      counts[status] = (counts[status] || 0) + 1;
      maxPeak = Math.max(maxPeak, peak); maxMs = Math.max(elapsed, maxMs); total++;
    }
    console.log(format + " " + Object.entries(counts).map(([key, n]) => n + " " + key).join(", "));
  }
  console.log("Importer cases: " + total + ", seed 0x" + options.seed.toString(16) +
    ", peak " + (maxPeak / MiB).toFixed(1) + " MiB, longest " + maxMs + " ms.");
}
module.exports = {run};
