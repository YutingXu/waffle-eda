"use strict";
// The native runner supplies a working directory, not an OS filesystem jail. Only a
// self-contained circuit crosses that boundary. Never forward a project path or a control deck.
const Raw = require("./raw.js"), X = require("./export.js"), S = require("./spice.js");
const IDENT = /^[A-Za-z0-9_][\w.+#-]*$/;
const numeric = word => Number.isFinite(S.num(word));
const assignment = word => { const pair = /^[A-Za-z_]\w*=(.+)$/.exec(word); return !!pair && numeric(pair[1]); };
const param = word => numeric(word) || /^\{[A-Za-z_]\w*\}$/.test(word);

function checkCard(line) {
  const words = line.replace(/[(),]/g, " ").replace(/\s*=\s*/g, "=").trim().split(/\s+/);
  const [name, ...args] = words, card = name.toLowerCase();
  if (card === ".model") return IDENT.test(args[0]) && /^(d|npn|pnp|nmos|pmos|njf|pjf|sw|csw)$/i.test(args[1]) && args.slice(2).every(assignment);
  if (card === ".param") return args.length && args.every(assignment);
  if (card === ".subckt") return args.length >= 2 && args.every(w => IDENT.test(w) || assignment(w) || /^params:$/i.test(w));
  if (card === ".ends") return args.length <= 1 && args.every(w => IDENT.test(w));
  if (card === ".ic") return /^\.ic(?:\s+v\([\w.+#-]+\)\s*=\s*[\w.+-]+)+$/i.test(line);
  if (!IDENT.test(name)) return false;
  const kind = name[0].toUpperCase();
  if (kind === "B") {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+([VIQ])\s*=\s*(.*)$/i.exec(line);
    if (!m || !IDENT.test(m[2]) || !IDENT.test(m[3]) || /[$\\]/.test(m[5])) return false;
    require("./expr.js").parse(m[5]); // arithmetic, node readings and the supported math functions
    return true;
  }
  if ("VI".includes(kind))
    return args.slice(0, 2).every(w => IDENT.test(w)) && args.length >= 3 && args.slice(2).every(w => numeric(w) || /^(dc|ac|pulse|pwl|sin|sine|exp|sffm)$/i.test(w));
  // Each device family has a specific number of node, controlling-element and model names.
  // All remaining device parameters must be numeric. In particular no file-backed sources,
  // code models, paths, interpreter substitutions or simulator commands pass through.
  const idCount = {R: 2, C: 2, L: 2, E: 4, G: 4, F: 3, H: 3, K: 2, D: 3, J: 4, M: 5, S: 5, W: 4};
  if (kind === "X") return args.length >= 2 && args.every(w => IDENT.test(w) || assignment(w));
  const count = kind === "Q" ? (args.length >= 5 && IDENT.test(args[4]) && !numeric(args[4]) ? 5 : 4) : idCount[kind];
  return count != null && args.length >= count && args.slice(0, count).every(w => IDENT.test(w)) &&
    args.slice(count).every(w => param(w) || assignment(w) || /^off$/i.test(w));
}

function deckFor(text, analysis, engine) {
  const analysisLine = X.analysisCard(analysis.type === "tran" ? {...analysis, tmax: analysis.tmax || analysis.tstep} : analysis);
  const words = analysisLine.split(/\s+/);
  if (analysis.type === "dc" && (!IDENT.test(analysis.source) || !/^[vi]/i.test(analysis.source)) ||
      analysis.type === "ac" && !["lin", "oct", "dec"].includes(analysis.sweep || "dec") ||
      /[\r\n]/.test(analysisLine) || !words.slice(({op: 1, ac: 2, dc: 2, tran: 1})[analysis.type]).every(w => numeric(w) || w === "uic"))
    throw Error("Invalid external analysis settings.");
  const cards = [];
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n").slice(1)) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line || line.startsWith("*")) continue;
    if (/[\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029]/.test(line)) throw Error("Invalid control character in SPICE deck.");
    if (line.startsWith("+") && cards.length) cards[cards.length - 1] += " " + line.slice(1).trim();
    else cards.push(line);
  }
  const deck = ["* Waffle SPICE test bench"];
  for (const line of cards) {
    const name = line.split(/\s+/)[0];
    if (/^\.(op|dc|tran|ac|probe|save|end)$/i.test(name)) continue;
    if (!checkCard(line)) throw Error("External benches require self-contained device and model cards. Unsupported card: " + name.slice(0, 80) + ".");
    deck.push(line);
  }
  if (engine === "ltspice") deck.push(".options plotwinsize=0");
  if (analysis.type === "tran" && analysis.method === "be") deck.push(".options method=gear maxord=1");
  deck.push(analysisLine, ".end");
  return deck.join("\n") + "\n";
}

const fatal = /^\s*(?:fatal\b|error\b|.*\bfatal error\b|unknown (?:device|subcircuit|parameter)|(?:could not|cannot|can't) (?:open|find|resolve)|missing (?:model|node)|.*simulation (?:failed|aborted)|.*time\s?step too small)|:\s*error\b|\bdeck\.cir\(\d+\):\s*(?!warning\b)\S/im;
function diagnostic(text, failed) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(l => fatal.test(l));
  if (first < 0 && !failed) return "";
  const from = first >= 0 ? first : Math.max(0, lines.length - 8);
  return lines.slice(from, from + 8).join("\n").trim().slice(0, 1200);
}

function involved(message, deck, design) {
  const lines = deck.split("\n"), context = [message];
  const models = new Set();
  for (const line of lines) {
    const definition = /^\.(?:model|subckt)\s+(\S+)/i.exec(line);
    if (definition) models.add(definition[1].toLowerCase());
  }
  for (const m of message.matchAll(/\bline\s*(?:no\.?)?\s*[:#]?\s*(\d+)|\bdeck\.cir\((\d+)\)/gi)) {
    const index = Number(m[1] || m[2]) - 1;
    if (!lines[index]) continue;
    context.push(lines[index]);
    for (let i = index; i >= 0; i--) {
      if (/^\.ends\b/i.test(lines[i])) break;
      if (/^\.subckt\s/i.test(lines[i])) { context.push(lines[i].split(/\s+/)[1]); break; }
    }
  }
  const tokens = context.join(" ").toLowerCase().match(/[\w.+#-]+/g) || [];
  const names = new Set(tokens.flatMap(t => [t.replace(/^\.+|\.+$/g, ""), ...t.split(".")]));
  const refs = new Set();
  for (const e of design?.elements || []) {
    const words = e.line.toLowerCase().split(/\s+/);
    if (names.has(words[0]) || names.has(String(e.ref).toLowerCase()) || words.some(w => models.has(w) && names.has(w))) refs.add(e.ref);
  }
  return [...refs];
}

async function run(api, engine, text, analysis, design) {
  if (engine !== "ltspice" && engine !== "ngspice") throw Error("Unknown SPICE engine.");
  let deck = text;
  try {
    deck = deckFor(text, analysis, engine);
    const args = engine === "ngspice" ? ["-n", "-b", "-r", "deck.raw", "deck.cir"] : ["-b", "deck.cir"];
    const result = await api.external.run(engine, {args, files: {"deck.cir": deck},
      outputs: engine === "ltspice" ? ["deck.raw", "deck.log"] : ["deck.raw"], encoding: "binary", timeoutMs: 60000});
    if (result.cancelled) throw Error("Simulation cancelled.");
    if (result.timedOut) throw Error("Simulation timed out.");
    if (result.truncated) throw Error("Simulation output exceeded the size limit. Use fewer points or a shorter analysis.");
    const file = name => result.files.find(f => f.name.toLowerCase() === name)?.bytes;
    const raw = file("deck.raw"), log = file("deck.log");
    const output = [log && Raw.decode(new Uint8Array(log)), result.stderr, result.stdout].filter(Boolean).join("\n");
    const failed = result.exitCode !== 0 || !raw;
    const detail = diagnostic(output, failed);
    if (failed || detail) throw Error(detail || (result.exitCode === 0 ? "No rawfile was produced." : "The simulator exited with " + (result.signal ? "signal " + result.signal : "code " + result.exitCode) + "."));
    const res = Raw.parse(raw, engine, analysis, design);
    res.stats.ms = result.durationMs;
    res.warnings = output.split(/\r?\n/).filter(l => /^\s*warning\b/i.test(l)).slice(0, 40);
    return res;
  } catch (err) {
    const error = Error((engine === "ltspice" ? "LTspice" : "ngspice") + ": " + err.message);
    error.refs = involved(err.message, deck, design);
    throw error;
  }
}

module.exports = {run};
