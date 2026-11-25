"use strict";
// Pairing round trip in two Chrome windows through the real Share dialog (docs/collaboration.md,
// Other ways to connect), served by the relay's --dev mode:
//   A. no relay server set: the host's window is the relay; Bob pastes Alice's pairing code into
//      Join, sends back his reply, Alice pastes it, and Bob gets the project and her edits;
//   B. a relay server set: the same pairing carries Bob's connection to the relay through Alice.
//   C. "Visible on this network": the host's window starts the Linux app's LAN relay
//      (native/linux/lan_relay.py, on loopback here, the app's bridge stood in for), shows the session
//      code; Bob finds the session (the mDNS list stood in for), enters the code and joins; joining by
//      typed address works the same; when Alice leaves, nothing listens any more.
// Also checks the Join field's recognition, keyboard-only use (Enter joins), and writes the docs'
// screenshots in both themes (--shots DIR). Needs playwright-core and Chrome (CHROME=/path).
//   NODE_PATH=…/node_modules node tests/project/collab-pair-browser.cjs [--shots docs/images | --edit-locks]
// --edit-locks runs just the reviewed calculator, saved proposal and script checks with a real peer claim.
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const fs = require("node:fs"), path = require("node:path");
const ROOT = path.resolve(__dirname, "../..");
const shots = (i => i >= 0 ? path.resolve(process.argv[i + 1]) : null)(process.argv.indexOf("--shots"));
let chromium;
try { ({chromium} = require("playwright-core")); } catch { console.log("collab-pair-browser: SKIP (no playwright-core)"); process.exit(0); }
const chrome = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(c => c && fs.existsSync(c));
if (!chrome) { console.log("collab-pair-browser: SKIP (no Chrome)"); process.exit(0); }

function relay() {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", ["-I", path.join(ROOT, "collab/relay/waffle_relay.py"), "--dev", "--port", "0", "--quiet"], {stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    const seen = d => { out += d; const m = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve({p, port: +m[1]}); };
    p.stdout.on("data", seen); p.stderr.on("data", seen);
    p.on("exit", c => reject(Error("relay exited " + c + ": " + out)));
  });
}
async function editor(browser, port, name, relayUrl) {
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}});
  await ctx.addInitScript(([name, relayUrl]) => {
    try { localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1, values: {"general.startPage": "never", "collab.displayName": name, "collab.realtime": true, "collab.relay": relayUrl}})); } catch { /* storage */ }
  }, [name, relayUrl]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto("http://127.0.0.1:" + port + "/app/index.html");
  await page.waitForFunction(() => globalThis.AtriumNavHost?.project?.() && globalThis.AtriumLazy);
  await page.evaluate(() => AtriumLazy.need(["AtriumCollabPresence", "AtriumCollabTransport"]));
  return {ctx, page, errors};
}
const dialog = page => page.locator("dialog.collab-dialog[open]");
const networkExplanation = page => page.getByRole("dialog", {name: "Local network access", exact: true});
async function shoot(page, name) {
  if (!shots) return;
  for (const theme of ["dark", "light"]) {
    await page.evaluate(t => AtriumTheme.set({preset: t}, {persist: false}), theme);
    await dialog(page).screenshot({path: path.join(shots, name + "-" + theme + ".png"), animations:"disabled"});
  }
  await page.evaluate(() => AtriumTheme.set({preset: "dark"}, {persist: false}));
}

async function pairing(browser, port, relayUrl, label) {
  const alice = await editor(browser, port, "Alice", relayUrl), bob = await editor(browser, port, "Bob", relayUrl);
  const A = alice.page, B = bob.page;
  await A.evaluate(() => AtriumNavHost.replaceProject(AtriumParts.example(), {force: true, copy: true, dirty: false}));
  for (const page of [A, B]) await page.locator("#collab-share").waitFor({state: "visible"}).catch(async () => {
    throw Error("Share is not visible: " + await page.evaluate(() => { const b = document.querySelector("#collab-share"), r = b.getBoundingClientRect(); return JSON.stringify({hidden: b.hidden, w: r.width, h: r.height, d: getComputedStyle(b).display, parent: b.parentElement?.id}); }));
  });
  // Alice hosts. Without a relay server, Other ways to connect is open and a code is one press away.
  await A.click("#collab-share");
  await dialog(A).getByRole("button", {name: "Start Session"}).click();
  await A.waitForFunction(() => AtriumCollabLive.session()?.t?.state === "open");
  if (relayUrl) {
    await dialog(A).locator("summary", {hasText: "Other ways to connect"}).click();
    assert.ok(await dialog(A).locator("svg.collab-qr").count() === 1, label + ": the link has a QR code");
  }
  await dialog(A).getByRole("button", {name: "Create Pairing Code"}).click();
  const codeBox = dialog(A).getByLabel("Pairing code");
  await A.waitForFunction(() => /^atrium-offer\./.test(document.querySelector("dialog.collab-dialog[open] .collab-ways textarea")?.value || ""));
  const code = await codeBox.inputValue();
  // Bob pastes it into Join; the field says what it is; Enter joins.
  await B.click("#collab-share");
  const field = dialog(B).locator("textarea").first();
  await field.fill("atrium-reply.z.abc");
  assert.match(await dialog(B).locator(".collab-detected").textContent(), /pairing reply/, label + ": a reply is recognised");
  await field.fill("192.168.1.20:48765");
  assert.match(await dialog(B).locator(".collab-detected").textContent(), /An address/, label + ": an address is recognised");
  await field.fill(code.replace(/(.{70})/g, "$1\n"));
  assert.match(await dialog(B).locator(".collab-detected").textContent(), /A pairing code/, label + ": the code is recognised, line breaks and all");
  if (!relayUrl) await shoot(B, "collab-share");
  await field.press("Enter");
  const replyBox = dialog(B).getByLabel("Your reply");
  await B.waitForFunction(() => /^atrium-reply\./.test(document.querySelector("dialog.collab-dialog[open] textarea")?.value || ""));
  const reply = await replyBox.inputValue();
  assert.ok(!reply.includes(code.slice(14, 60)), label + ": the reply is not the code");
  // Alice pastes the reply and connects (Enter in the field).
  const replyField = dialog(A).getByLabel("Their reply");
  await replyField.fill(reply);
  if (!relayUrl) await shoot(A, "collab-pairing");
  await replyField.press("Enter");
  await B.waitForFunction(() => AtriumCollabLive.session()?.r, null, {timeout: 30000});
  const ids = p => p.evaluate(() => AtriumNavHost.project().documents.map(d => d.id).join());
  assert.equal(await ids(B), await ids(A), label + ": Bob has Alice's project");
  // An edit travels, and the people list says how Bob is connected.
  await A.evaluate(() => { const h = AtriumNavHost, b = h.project().documents.find(d => d.kind === "pcb"); h.edit(() => b.items.push({id: "paired-via", kind: "via", x: 5, y: 5, diameter: .8})); });
  const viaSeen = await B.waitForFunction(() => AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === "paired-via")), null, {timeout: 8000}).then(() => true, () => false);
  const chip = await A.waitForFunction(() => [...document.querySelectorAll("dialog.collab-dialog[open] .collab-chip")].map(c => c.textContent).join("|"), null, {timeout: 8000}).then(h => h.jsonValue());
  assert.match(chip, /Bob · /, label + ": Bob is listed with his connection");
  await dialog(A).locator(".collab-chip").first().press("Enter");
  assert.match(await dialog(A).locator(".collab-people + .collab-note").textContent(), /end-to-end encrypted/, label + ": choosing a chip explains it");
  assert.deepEqual([...alice.errors, ...bob.errors], [], label + ": no page errors");
  await Promise.all([alice.ctx.close(), bob.ctx.close()]);
  return {viaSeen, chip};
}

async function reviewedEditLocks(browser, port) {
  const url = "ws://127.0.0.1:" + port;
  const [reviewer, holder] = await Promise.all(["Reviewer", "Holder"].map(name => editor(browser, port, name, url)));
  const A = reviewer.page, B = holder.page;
  const state = page => page.evaluate(() => {
    AtriumCollabLive.flush();
    return {design: AtriumNavHost.project(), steps: AtriumNavHost.undoSteps().history.length, personal: AtriumCollabLive.historyAvailability()};
  });
  const width = p => p.documents.find(d => d.id === "board").items.find(i => i.id === "clock").width;
  async function claim(id) {
    await B.evaluate(id => { const h = AtriumNavHost; h.selectDocument("board"); h.setTool("move-object"); h.select([id]); }, id);
    await A.waitForFunction(id => AtriumCollabLive.peers().some(p => p.lock?.length === 1 && p.lock[0] === id), id);
  }
  const peerWidth = value => B.waitForFunction(v => AtriumNavHost.docById("board").items.find(i => i.id === "clock").width === v, value);
  try {
    await Promise.all([A, B].map(page => page.evaluate(() => {
      globalThis.ATRIUM_UNDO_VERIFY = "throw";
      return AtriumLazy.need(["AtriumRules", "AtriumUndoStore", "AtriumExtensions", "AtriumAI"]);
    })));
    const bench = await A.evaluate(require("../analysis/calculator-design.js"));
    await A.evaluate(async p => { Atrium.validate(p); await AtriumNavHost.replaceProject(p, {force: true, dirty: false}); AtriumNavHost.selectDocument("board"); }, bench);
    const invite = await A.evaluate(async url => (await AtriumCollabLive.start(url)).link, url);
    await B.evaluate(link => AtriumCollabLive.join(link), invite);
    await Promise.all([A, B].map(page => page.waitForFunction(() => AtriumCollabLive.session()?.r &&
      AtriumCollabLive.peers().some(p => p.personalUndo) && AtriumNavHost.docById("board"))));
    await A.locator("details[data-menu=tools] > summary").click();
    await A.locator('details[data-menu=tools] [data-action="calculators"]').click();
    await A.evaluate(() => AtriumNavHost.select(["clock"]));
    const apply = A.locator(".panel-calc:visible").getByRole("button", {name: "Apply", exact: true});
    await A.waitForFunction(() => document.querySelector(".calc-proposal:not([hidden]) span")?.textContent.startsWith("Track width"));
    const base = await state(A), remote = await state(B);
    assert.deepEqual(remote.design, base.design);
    assert.deepEqual(base.personal, {undo: false, redo: false});

    await claim("clock");
    await apply.click();
    assert.match(await A.locator("#status").textContent(), /Holder.*CLOCK/);
    assert.deepEqual(await state(A), base, "the claimed calculator target stays unchanged and adds no Undo step");
    const denied = await A.evaluate(async () => {
      const h = AtriumNavHost, p = h.project(), i = h.docById("board").items.find(i => i.id === "clock");
      const ops = [{op: "set", target: "item", document: "board", id: i.id, path: ["width"], before: i.width, after: .18}];
      const saved = AtriumAI.apply({project: p, currentProject: h.project, defs: h.defs(), edit: h.edit}, {format: "atrium-ai", version: 2, project: p.name, ops});
      const script = await AtriumExtensions.runScript('return await api.transaction("Edit width", tx => tx.update("clock", {width: .18}));');
      return {saved, script: script.ok, blocked: script.value?.blocked, applied: script.value?.applied, steps: script.undoSteps};
    });
    assert.deepEqual(denied, {saved: 0, script: true, blocked: true, applied: 0, steps: 0});
    assert.deepEqual(await state(A), base);
    assert.deepEqual(await state(B), remote);

    await claim("spare");
    await apply.click();
    const accepted = await state(A), after = width(accepted.design);
    assert.notEqual(after, width(base.design));
    const expected = structuredClone(base.design);
    expected.documents.find(d => d.id === "board").items.find(i => i.id === "clock").width = after;
    assert.deepEqual(accepted, {design: expected, steps: base.steps + 1, personal: {undo: true, redo: false}});
    await peerWidth(after);
    assert.deepEqual((await state(B)).design, expected);
    await A.evaluate(() => AtriumNavHost.act("undo"));
    await peerWidth(width(base.design));
    const undone = await state(A);
    assert.deepEqual(undone.design, base.design);
    assert.deepEqual((await state(B)).design, remote.design);
    assert.deepEqual(undone.personal, {undo: false, redo: true});
    // A peer's completed edit can arrive between pointerdown and Drop or Escape.
    // Both the editor Undo mark and the personal history must exclude tentative poses.
    await B.evaluate(() => { const h = AtriumNavHost; h.setTool("select"); h.select([]); });
    await A.waitForFunction(() => AtriumCollabLive.peers().every(p => !p.lock?.length));
    await A.bringToFront();
    for (const cancel of [true, false]) {
      const initial = (await state(A)).design;
      const at = await A.evaluate(() => {
        const h = AtriumNavHost, track = h.doc().items.find(i => i.id === "clock");
        h.setTool("select"); h.select([track.id]); h.view().fit(h.doc(), h.defs()); h.redraw();
        // The board has a width-rule marker at the midpoint. Pick copper away from that marker.
        const [a, b] = track.points, [x, y] = h.view().worldToScreen(a.map((v, axis) => v + (b[axis] - v) / 4));
        const rect = h.canvas().getBoundingClientRect(); return [x + rect.left, y + rect.top];
      });
      await A.mouse.move(...at); await A.mouse.down(); await A.mouse.move(at[0] + 35, at[1] + 22, {steps: 3});
      await A.waitForFunction(() => AtriumNavHost.drag()?.before);
      const nextWidth = await B.evaluate(() => {
        const h = AtriumNavHost, spare = h.docById("board").items.find(i => i.id === "spare");
        h.edit(() => { spare.width += .01; }, "Set spare track width", [spare]);
        AtriumCollabLive.flush(); return spare.width;
      });
      await A.waitForFunction(() => AtriumCollabLive.session()?.dragMessages?.messages.length > 0);
      assert.notEqual(await A.evaluate(() => AtriumNavHost.docById("board").items.find(i => i.id === "spare").width), nextWidth);
      if (cancel) await A.keyboard.press("Escape");
      await A.mouse.up();
      await A.waitForFunction(v => !AtriumNavHost.drag() && AtriumNavHost.docById("board").items.find(i => i.id === "spare").width === v, nextWidth);
      const expected = structuredClone(initial);
      expected.documents.find(d => d.id === "board").items.find(i => i.id === "spare").width = nextWidth;
      const actual = await state(A);
      if (!cancel) {
        const points = actual.design.documents.find(d => d.id === "board").items.find(i => i.id === "clock").points;
        assert.notDeepEqual(points, expected.documents.find(d => d.id === "board").items.find(i => i.id === "clock").points);
        await B.waitForFunction(points => JSON.stringify(AtriumNavHost.docById("board").items.find(i => i.id === "clock").points) === JSON.stringify(points), points);
        await A.evaluate(() => AtriumNavHost.act("undo"));
      }
      assert.deepEqual((await state(A)).design, expected);
      await B.waitForFunction(expected => AtriumProposal.equal(AtriumNavHost.project(), expected), expected);
      assert.deepEqual((await state(B)).design, expected);
    }
    assert.deepEqual([...reviewer.errors, ...holder.errors], []);
  } finally { await Promise.all([reviewer.ctx.close(), holder.ctx.close()]); }
}

// The Waffle app's bridge for same-network sessions, backed by the real Linux LAN relay.
const LAN_HELPER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import lan_relay as L
lan = L.LanRelay(addresses=[], advertise=False)
r = lan.start(sys.argv[2], sys.argv[3], sys.argv[4])
r["addresses"] = ["127.0.0.1"]
print(json.dumps(r), flush=True)
for line in sys.stdin:
    line = line.strip()
    if line.startswith("host "):
        lan.set_host(line[5:])
    elif line == "stop":
        break
lan.stop()
print("stopped", flush=True)
`;
async function lanBridge(ctx, state) {
  await ctx.exposeFunction("testLanStart", (room, salt, name) => new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-I", "-c", LAN_HELPER, path.join(ROOT, "native/linux"), room, salt, name], {stdio: ["pipe", "pipe", "inherit"]});
    state.proc = proc; state.name = name;
    let out = "";
    proc.stdout.on("data", d => {
      out += d;
      const line = out.split("\n")[0];
      if (!state.started && out.includes("\n")) { state.started = JSON.parse(line); resolve(state.started); }
      if (out.includes("stopped")) state.stopped = true;
    });
    proc.on("exit", c => { if (!state.started) reject(Error("lan helper exited " + c)); });
  }));
  await ctx.exposeFunction("testLanHost", host => { state.host = host; state.proc?.stdin.write("host " + host + "\n"); return {ok: true}; });
  await ctx.exposeFunction("testLanStop", () => { state.proc?.stdin.write("stop\n"); return {stopped: true}; });
  await ctx.exposeFunction("testLanBrowse", () => ({sessions: state.started ? [{name: state.name, address: "127.0.0.1", port: state.started.port}] : []}));
}
const installBridge = page => page.evaluate(() => {
  window.AtriumHost = {lanAvailable: true, lanStart: (r, s, n) => testLanStart(r, s, n), lanHost: h => testLanHost(h), lanStop: () => testLanStop(), lanBrowse: () => testLanBrowse()};
});
function listening(port) {
  return new Promise(resolve => { const s = require("node:net").connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
}
async function sameNetwork(browser, port) {
  const state = {};
  const alice = await editor(browser, port, "Alice", ""), bob = await editor(browser, port, "Bob", ""), carol = await editor(browser, port, "Carol", "");
  for (const e of [alice, bob, carol]) { await lanBridge(e.ctx, state); await installBridge(e.page); }
  const A = alice.page, B = bob.page, C = carol.page;
  await A.evaluate(() => AtriumNavHost.replaceProject(AtriumParts.example(), {force: true, copy: true, dirty: false}));
  await A.click("#collab-share");
  assert.equal(state.proc, undefined, "nothing listens before the session starts");
  await dialog(A).getByLabel("Visible on this network").check();
  await dialog(A).getByLabel("Session name").fill("Board review");
  await dialog(A).getByRole("button", {name: "Start Session"}).click();
  // On macOS the Local Network permission prompt comes after Waffle's own explanation (once).
  if (await A.evaluate(() => /Mac/i.test(navigator.platform))) {
    const sheet = networkExplanation(A);
    await sheet.waitFor();
    assert.equal(state.proc, undefined, "nothing listens before the explanation is accepted");
    if (shots) for (const theme of ["dark", "light"]) { await A.evaluate(t => AtriumTheme.set({preset: t}, {persist: false}), theme); await sheet.screenshot({path: path.join(shots, "collab-lan-permission-" + theme + ".png"), animations:"disabled"}); }
    await sheet.getByRole("button", {name: "Continue"}).click();
  }
  await A.waitForFunction(() => AtriumCollabLive.session()?.t?.state === "open" && document.querySelector("dialog.collab-dialog[open] .collab-code")).catch(async e => { throw Error("not open: " + JSON.stringify(await A.evaluate(() => [AtriumCollabLive.session()?.status, AtriumCollabLive.session()?.t?.state, document.querySelector("dialog.collab-dialog[open]")?.textContent?.slice(0, 600)])) + JSON.stringify(state)); });
  const code = (await dialog(A).locator(".collab-code").textContent()).trim();
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/, "a 16-character code to read out");
  assert.equal(state.name, "Board review", "the network sees the session name only");
  await A.waitForFunction(() => true);
  assert.ok(state.host, "the host's peer id is known to the listener (for guests to verify)");
  if (shots) await shoot(A, "collab-lan-host");
  // Bob finds it, enters the code (lower case, no dashes), and joins.
  await B.click("#collab-share");
  await dialog(B).getByRole("button", {name: "Find Sessions on This Network"}).click();
  if (await B.evaluate(() => /Mac/i.test(navigator.platform))) await networkExplanation(B).getByRole("button", {name: "Continue"}).click();
  await dialog(B).getByRole("button", {name: /^Board review — 127\.0\.0\.1:/}).click();
  await dialog(B).getByLabel("Session code").fill(code.toLowerCase().replace(/-/g, ""));
  if (shots) await shoot(B, "collab-lan-join");
  await dialog(B).getByLabel("Session code").press("Enter");
  await B.waitForFunction(() => AtriumCollabLive.session()?.r, null, {timeout: 30000});
  const ids = p => p.evaluate(() => AtriumNavHost.project().documents.map(d => d.id).join());
  assert.equal(await ids(B), await ids(A), "same network: Bob has Alice's project");
  assert.equal(await B.evaluate(() => AtriumCollabLive.session().host), state.host, "Bob knows (and verifies) the host");
  // Carol types the address instead; a wrong code does not join.
  await C.click("#collab-share");
  const field = dialog(C).locator("textarea").first();
  await field.fill("127.0.0.1:" + state.started.port);
  assert.match(await dialog(C).locator(".collab-detected").textContent(), /An address/);
  await dialog(C).getByLabel("Session code").fill("AAAA-BBBB-CCCC-DDDD");
  await dialog(C).getByRole("button", {name: "Join Session"}).click();
  await C.waitForFunction(() => /room key does not match|Relay:/i.test(AtriumCollabLive.session()?.status || document.querySelector("dialog.collab-dialog[open]")?.textContent || ""), null, {timeout: 20000});
  assert.ok(!await C.evaluate(() => !!AtriumCollabLive.session()?.r), "a wrong code does not join");
  await C.evaluate(() => AtriumCollabLive.leave());
  // Alice leaves: the listener stops.
  const stopped = new Promise(resolve => state.proc.once("close", resolve));
  await A.evaluate(() => AtriumCollabLive.leave());
  assert.deepEqual([await stopped, state.stopped], [0, true], "the host's leaving stops the listener cleanly");
  assert.equal(await listening(state.started.port), false, "nothing listens after the session");
  assert.deepEqual([...alice.errors, ...bob.errors, ...carol.errors], [], "same network: no page errors");
  await Promise.all([alice.ctx.close(), bob.ctx.close(), carol.ctx.close()]);
}

module.exports = {relay, editor};
if (require.main === module) (async () => {
  const {p, port} = await relay();
  const browser = await chromium.launch({executablePath: chrome, headless: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--no-first-run"]});
  try {
    await reviewedEditLocks(browser, port);
    console.log("collab-pair-browser: reviewed edits respect peer claims; committed drags, Escape and personal Undo preserve peer edits");
    if (process.argv.includes("--edit-locks")) return;
    const a = await pairing(browser, port, "", "no server");
    assert.ok(a.viaSeen, "no server: Alice's edit reaches Bob");
    assert.match(a.chip, /through the host/, "no server: Bob's edits go through Alice's window");
    const b = await pairing(browser, port, "ws://127.0.0.1:" + port, "relay");
    // Preferences › Test Connection against the same relay (a throwaway room, and /healthz).
    const probe = await editor(browser, port, "Probe", "");
    const result = await probe.page.evaluate(u => AtriumCollabLive.testConnection(u), "ws://127.0.0.1:" + port);
    assert.match(result, /^Connected in \d+ ms \(relay protocol 2\)\. TURN is off/, result);
    assert.match(await probe.page.evaluate(() => AtriumCollabLive.testConnection("ws://127.0.0.1:9")), /Couldn't connect/);
    await probe.ctx.close();
    assert.ok(b.viaSeen, "relay: Alice's edit reaches Bob");
    await sameNetwork(browser, port);
    console.log("collab-pair-browser: ok (pairing through the Share dialog without a server and with a relay, Join recognition, Enter joins and connects, edits travel, people chips explain paths, Test Connection, same network: visible session, code, find, join by address, wrong code, listener stops" + (shots ? ", screenshots" : "") + ")");
  } finally {
    await browser.close();
    p.kill();
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
