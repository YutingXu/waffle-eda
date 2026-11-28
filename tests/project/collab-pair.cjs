"use strict";
// Pairing codes (app/project/collab-pair.js), Node part: the code format (compressed, whitespace-tolerant,
// damaged codes refused), and the host's in-window relay (hub) carrying the real transport
// (app/project/collab-transport.js) over data-channel stand-ins: joins, end-to-end messages between the host
// and guests and between guests, large bodies in pieces, a wrong key refused, leaving.
// The round trip in two Chrome windows, through the real Share dialog, is tests/project/collab-pair-browser.cjs.
const assert = require("node:assert/strict");
const {webcrypto} = require("node:crypto");
Object.defineProperty(globalThis, "crypto", {value: webcrypto, configurable: true});
require("../../app/project/collab-transport.js");
require("../../app/project/collab-pair.js");
const T = globalThis.AtriumCollabTransport, P = globalThis.AtriumCollabPair;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(test, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw Error("timed out: " + what); await tick(5); }
}
// Two ends of a data channel.
function channels() {
  const make = () => ({readyState: "open", bufferedAmount: 0, onmessage: null, closers: [],
    addEventListener(type, fn) { if (type === "close") this.closers.push(fn); },
    send(d) { if (this.readyState !== "open") throw Error("closed"); setImmediate(() => this.other.readyState === "open" && this.other.onmessage?.({data: d})); this.sent = (this.sent || 0) + 1; },
    close() { if (this.readyState !== "open") return; this.readyState = this.other.readyState = "closed"; for (const end of [this, this.other]) for (const f of end.closers) setImmediate(f); }});
  const a = make(), b = make(); a.other = b; b.other = a;
  return [a, b];
}

(async () => {
  // ---- codes ----
  const offer = {v: 1, i: "0123abcd", sdp: "v=0\r\n" + "a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host\r\n".repeat(8), k: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456"};
  const code = await P.pack("atrium-offer.", offer);
  assert.ok(code.startsWith("atrium-offer.z."), "compressed");
  assert.ok(code.length < JSON.stringify(offer).length, "smaller than the JSON");
  assert.deepEqual(await P.unpack("atrium-offer.", code), offer);
  const mangled = "  " + code.replace(/(.{60})/g, "$1\r\n ") + "\n";
  assert.deepEqual(await P.unpack("atrium-offer.", mangled), offer, "line breaks and spaces from a chat are ignored");
  assert.equal(P.kind(mangled), "offer");
  assert.equal(P.kind("atrium-reply.z.abc"), "reply");
  assert.equal(P.kind("https://example.org"), null);
  await assert.rejects(P.unpack("atrium-offer.", code.slice(0, -12)), /damaged|incomplete/, "a cut code is refused");
  await assert.rejects(P.unpack("atrium-reply.", code), /not a pairing reply/);
  await assert.rejects(P.unpack("atrium-offer.", "atrium-offer.z." + "A".repeat(60000)), /not a pairing code/, "an oversized code is refused");

  // ---- the hub carries the real transport ----
  const roomKey = T.newRoomKey(), salt = T.newSalt(), k = await T.keys(roomKey, salt);
  const hub = P.hub(k.room, k.auth);
  const got = {host: [], g1: [], g2: [], g3: []}, states = {host: [], g1: [], g2: [], g3: []};
  const listen = name => ({onMessage(kind, body, from) { got[name].push({kind, body, from}); }, onState(s) { states[name].push(s); }});
  const host = await T.connect({url: "ws://pair.invalid", roomKey, salt, path: "relay", WebSocket: hub.hostSocket, ...listen("host")});
  await until(() => host.state === "open", "host open");
  const guest = (name, key = roomKey) => {
    const [mine, theirs] = channels();
    hub.attach(P.channelSocket(theirs));
    let used = false;
    return T.connect({url: "ws://pair.invalid", roomKey: key, salt, path: "relay", WebSocket: P.socketClass(() => used ? null : (used = true, P.channelSocket(mine))), ...listen(name)}).then(t => Object.assign(t, {channel: mine}));
  };
  const g1 = await guest("g1"), g2 = await guest("g2");
  await until(() => g1.state === "open" && g2.state === "open", "guests open");
  assert.equal(hub.size(), 3);
  await host.send("hello", {name: "Host"});
  await until(() => got.g1.some(m => m.kind === "hello") && got.g2.some(m => m.kind === "hello"), "the host's hello reaches both guests");
  assert.equal(got.g1.find(m => m.kind === "hello").from, host.peer, "from the host's verified peer id");
  const big = "x".repeat(300 * 1024);
  await g1.send("ops", {big});
  await until(() => got.host.some(m => m.body?.big) && got.g2.some(m => m.body?.big), "a large body in pieces");
  assert.equal(got.g2.find(m => m.body?.big).body.big.length, big.length);
  assert.equal(got.g2.find(m => m.body?.big).from, g1.peer, "guest to guest through the host's window");
  assert.ok(g1.channel.sent > 18, "sent in pieces of " + P.constants.PIECE + " characters");
  // A wrong key: refused by the hub, before anything is decrypted.
  const bad = await guest("g3", T.newRoomKey()).catch(e => e);
  await until(() => states.g3.includes("error"), "a wrong key is refused by the hub", 3000);
  assert.notEqual(bad.state, "open", "a wrong key does not join");
  assert.equal(hub.size(), 3);
  // A guest whose channel closes leaves the session for the others.
  g2.channel.close();
  await until(() => host.paths().size === 1, "the guest who left is gone");
  hub.close();
  for (const t of [host, g1, g2, bad]) t.close?.();
  console.log("collab-pair: ok (codes compressed and whitespace-tolerant, damaged codes refused, hub joins, host and guest messages, large bodies in pieces, wrong key refused, leaving)");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
