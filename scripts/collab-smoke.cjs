#!/usr/bin/env node
"use strict";
// Live-session smoke test against a relay: two headless Chromium editors join one room with the
// real transport (app/project/collab-transport.js), exchange edits, and report the path each mode used and
// the round-trip time of an edit and its echo.
//
//   node scripts/collab-smoke.cjs wss://collab.example.org [--host-token TOKEN] [--modes auto,turn,relay] [--rounds 20] [--json]
//   python3 scripts/collab-smoke.py ...   (finds Node and Playwright for you)
//
// Modes: auto (WebRTC, direct when possible), turn (WebRTC through TURN only), relay (WebSocket relay
// only). Needs playwright-core (or playwright) and Chrome/Chromium (CHROME=/path, else the system
// Chrome, else Playwright's own). Exit status 1 when the relay or the forced-relay path fails.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const relay = args.find(a => /^wss?:\/\//i.test(a));
const opt = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : d; };
if (!relay) { console.error("usage: collab-smoke.cjs ws(s)://relay [--modes auto,turn,relay] [--rounds 20] [--json]"); process.exit(2); }
const hostToken = opt("host-token", process.env.ATRIUM_HOST_TOKEN || "") || undefined;   // a private relay's host invitation token
const modes = opt("modes", "auto,turn,relay").split(",").filter(Boolean), rounds = Math.max(1, +opt("rounds", 20) || 20), asJSON = args.includes("--json");
const APP = path.resolve(__dirname, "..", "app");

function playwright() {
  for (const name of ["playwright", "playwright-core"]) { try { return require(name); } catch { /* next */ } }
  console.error("collab-smoke: install playwright-core (or set NODE_PATH to a node_modules that has it)");
  process.exit(2);
}
function chromePath() {
  for (const c of [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (c && fs.existsSync(c)) return c;
  return undefined;
}
// A page on 127.0.0.1 (a secure context for Web Crypto and WebRTC) with just the transport.
function serve() {
  const page = "<!doctype html><meta charset=utf-8><title>Waffle collab smoke</title><script src=/collab-transport.js></script>";
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, {"content-type": "text/html"}); res.end(page); return; }
    if (req.url === "/collab-transport.js") { res.writeHead(200, {"content-type": "text/javascript"}); res.end(fs.readFileSync(path.join(APP, "project/collab-transport.js"))); return; }
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

// Runs in each page: join, then echo or ping.
const PAGE = async ({relay, roomKey, mode, role, rounds, hostToken}) => {
  const T = globalThis.AtriumCollabTransport, log = [];
  let resolveEcho, other = null;
  const t = await T.connect({url: relay, roomKey, path: mode, hostToken: role === "ping" ? hostToken : undefined, owner: role === "ping" ? "smoke-owner-" + roomKey : undefined,
    onMessage(kind, body, from) {
      if (kind === "hello") other = from;
      else if (kind === "ops" && body?.ping !== undefined && role === "echo") t.send("ops", {pong: body.ping, to: from});
      else if (kind === "ops" && body?.pong !== undefined) resolveEcho?.(body.pong);
    },
    onState(s, d) { log.push(s + (d && typeof d === "object" ? " " + JSON.stringify(d) : d !== undefined ? " " + d : "")); }});
  globalThis.smoke = t;
  const until = async (test, ms) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 50)); } return true; };
  await until(() => t.state === "open", 15000);
  if (t.state !== "open") return {error: "could not join the relay: " + log.slice(-3).join("; "), log};
  t.send("hello", {role});
  const met = await until(() => other, 15000);
  if (!met) return {error: "the other editor never arrived", log};
  t.send("hello", {role});
  if (mode !== "relay") await until(() => ["direct", "turn"].includes(t.paths().get(other)), 12000);
  if (role === "echo") { await until(() => globalThis.smokeDone, 60000); return {path: t.paths().get(other), log}; }
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    const pong = new Promise(r => resolveEcho = r);
    t.send("ops", {ping: i, to: other});
    const got = await Promise.race([pong, new Promise(r => setTimeout(() => r(null), 5000))]);
    if (got !== i) return {error: "edit " + i + " was not echoed", path: t.paths().get(other), log};
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {path: t.paths().get(other), median: times[times.length >> 1], p90: times[Math.floor(times.length * .9)], rtc: t.rtc, stats: t.stats, log};
};

(async () => {
  const {chromium} = playwright(), server = await serve(), base = "http://127.0.0.1:" + server.address().port + "/";
  const browser = await chromium.launch({executablePath: chromePath(), headless: true,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--no-first-run"]});
  const results = {};
  let failed = false;
  try {
    for (const mode of modes) {
      const roomKey = await (async () => { const p = await browser.newPage(); await p.goto(base); const k = await p.evaluate(() => AtriumCollabTransport.newRoomKey()); await p.close(); return k; })();
      const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
      const [pa, pb] = await Promise.all([a.newPage(), b.newPage()]);
      await Promise.all([pa.goto(base), pb.goto(base)]);
      // The pinging editor hosts (opens the room, vouches for the other so it may use TURN).
      const pinging = pa.evaluate(PAGE, {relay, roomKey, mode, role: "ping", rounds, hostToken});
      await new Promise(r => setTimeout(r, 500));
      const echo = pb.evaluate(PAGE, {relay, roomKey, mode, role: "echo", rounds, hostToken});
      const ping = await pinging;
      await pb.evaluate(() => { globalThis.smokeDone = true; });
      const other = await echo;
      await Promise.all([pa.evaluate(() => smoke.close()), pb.evaluate(() => smoke.close())]).catch(() => {});
      await Promise.all([a.close(), b.close()]);
      results[mode] = ping;
      const expected = mode === "relay" ? ["relay"] : mode === "turn" ? ["turn"] : ["direct", "turn"];
      const ok = !ping.error && expected.includes(ping.path);
      if (!ok && mode === "relay") failed = true;
      if (!asJSON) {
        const label = {auto: "WebRTC (auto)", turn: "WebRTC via TURN only", relay: "relay only"}[mode] || mode;
        if (ping.error) console.log("FAIL  %s: %s%s", label, ping.error, ping.path ? " (path " + ping.path + ")" : "");
        else console.log("%s  %s: path %s, round trip median %s ms, p90 %s ms over %d edits%s", ok ? "ok  " : "WARN", label, ping.path,
          ping.median.toFixed(1), ping.p90.toFixed(1), rounds, ok ? "" : " (expected " + expected.join(" or ") + ")");
        if (!ok && mode === "turn") console.log("      TURN: is coturn running and are 3478 and 49152-49999/udp open? (sudo waffle-collab turn-test)");
        if (process.env.SMOKE_VERBOSE) console.log("      " + [...(ping.log || []), "echo side: " + (other.path || other.error)].join("\n      "));
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (asJSON) console.log(JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("collab-smoke:", e.message); process.exit(1); });
