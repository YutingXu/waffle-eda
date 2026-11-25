"use strict";
const assert = require("node:assert/strict");
const serveApp = require("../support/browser-app-server.cjs");
const {profile} = require("../fixtures/notebook-labs.cjs");

const owner = "test.fable", peer = "test.cinder";
const heldQuery = "lifecycle-pending";

function packageFiles(id, label) {
  const command = id + ".open";
  return {
    "waffle-extension.json": JSON.stringify({
      id, name: label + " Parts", version: "1.0.0", apiVersion: 1, main: "main.js",
      permissions: ["ui:command"],
      contributes: {
        paletteCommands: [{id: "open", name: "Lifecycle proof " + label, command}],
        searchProviders: [{id: "local", name: label, command, module: "search.js", data: "label.json", hosts: []}]
      }
    }),
    "main.js": `exports.activate = api => api.commands.register("${command}",
      () => ({kind: "detail", title: "${label} detail", text: "Local fixture"}));`,
    "search.js": "exports.search = ({query}, {data}) => [{id: 'result', label: data.label + ' ' + query}];",
    "label.json": JSON.stringify({id, label})
  };
}

// Observe the real sandbox channels in the application frame. Defer selected
// responses after the actual worker has sent them so the UI controls race deterministically.
function observeSandbox() {
  if (window !== top) return;
  const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  const send = MessagePort.prototype.postMessage, NativeChannel = MessageChannel;
  const parentPorts = new WeakMap(), listeners = new WeakMap(), workers = new Map();
  const state = window.paletteLifecycle = {
    workers, ended: [], holds: new Set(), dispatches: [], packets: new Map(),
    release(key) {
      state.holds.delete(key);
      const packets = state.packets.get(key) || [];
      state.packets.delete(key);
      for (const packet of packets) packet.deliver();
    }
  };
  window.MessageChannel = class extends NativeChannel {
    constructor() { super(); parentPorts.set(this.port2, this.port1); }
  };
  MessagePort.prototype.postMessage = function(packet, ...options) {
    if (packet?.t === "spawn") workers.set(packet.id, listeners.get(parentPorts.get(packet.port)));
    if (packet?.t === "kill") state.ended.push(packet.id);
    const realm = listeners.get(this);
    if (!realm) return send.call(this, packet, ...options);
    for (const step of packet?.batch || []) {
      if (step.t === "activate") Object.assign(realm, {role: "command", owner: step.ext.id});
      if (step.t === "paletteInvoke" && state.holds.has(step.ext)) {
        realm.key = step.ext;
        realm.cid = step.cid;
      }
      if (step.t === "search" && step.data) {
        const owner = JSON.parse(step.data).id, query = step.query.query;
        Object.assign(realm, {role: "search", owner, key: owner + ":" + query, cid: step.cid});
        state.dispatches.push({owner, query});
      }
    }
    return send.call(this, packet, ...options);
  };
  Object.defineProperty(MessagePort.prototype, "onmessage", {
    ...descriptor,
    set(fn) {
      if (typeof fn !== "function") return descriptor.set.call(this, fn);
      const realm = {};
      listeners.set(this, realm);
      return descriptor.set.call(this, event => {
        const messages = event.data?.batch || [];
        const done = messages.some(m => m.t === "done" && m.cid === realm.cid);
        if (!state.holds.has(realm.key) || !(done || messages.some(m => m.t === "paletteRows"))) return fn.call(this, event);
        if (!state.packets.has(realm.key)) state.packets.set(realm.key, []);
        state.packets.get(realm.key).push({done, deliver: () => fn.call(this, event)});
      });
    }
  });
}

module.exports = async function paletteLifecycle(browser) {
  const server = await serveApp();
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const origin = new URL(server.url).origin + "/";
  await page.route("**/*", route => {
    const url = route.request().url();
    return url.startsWith(origin) || /^(data|blob):/.test(url) ? route.continue() : route.abort();
  });
  await profile(page, {"general.startPage": "never"});
  await page.addInitScript(observeSandbox);
  const palette = page.locator("#palette"), screen = palette.locator(".nav-palette-screen:not([hidden])");
  const manager = page.getByRole("dialog", {name: "Extensions", exact: true});
  const text = label => palette.getByText(label, {exact: true});
  const button = (within, name) => within.getByRole("button", {name, exact: true});
  const fableCard = manager.locator(".ext-card").filter({hasText: "Fable Parts"});
  const clickCommand = label => palette.getByRole("option").filter({hasText: "Lifecycle proof " + label}).first().click();
  const hold = key => page.evaluate(key => paletteLifecycle.holds.add(key), key);
  const sent = key => page.waitForFunction(key => paletteLifecycle.packets.get(key)?.some(p => p.done), key);
  const release = key => page.evaluate(key => paletteLifecycle.release(key), key);
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const showManager = () => page.evaluate(() => AtriumExtensions.openManager());
  const running = () => page.evaluate(() => AtriumExtensions.workers.map(w => w.pool).sort());
  async function query(value) {
    await page.evaluate(() => { globalThis.AtriumPalette?.close(false); AtriumNavHost.canvas().focus(); });
    await page.keyboard.press("/");
    await palette.getByRole("combobox").fill(value);
  }
  async function install(id, label) {
    const installation = page.evaluate(async files => { await AtriumExtensions.install(files); }, packageFiles(id, label));
    await button(page.locator("dialog.ext-prompt[open]"), "Install").click();
    await installation;
  }
  async function toggle(enabled) {
    await showManager();
    await fableCard.click();
    await button(manager, enabled ? "Enable" : "Disable").click();
    await button(manager, enabled ? "Disable" : "Enable").waitFor();
    await button(manager, "Close").click();
  }
  async function uninstall() {
    await showManager();
    await fableCard.click();
    await button(manager, "Uninstall").click();
    await button(page.getByRole("dialog", {name: "Uninstall Fable Parts"}), "Uninstall").click();
    await fableCard.waitFor({state: "detached"});
    await button(manager, "Close").click();
  }
  const targets = await browser.newBrowserCDPSession();
  async function sandboxTargets() {
    const {targetInfos} = await targets.send("Target.getTargets");
    const app = targetInfos.find(target => target.type === "page" && target.url === server.url);
    assert.ok(app);
    return targetInfos.filter(target => target.browserContextId === app.browserContextId &&
      target.type === "worker" && target.url.startsWith("blob:null/"));
  }
  const summary = {};
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => globalThis.AtriumNavHost && globalThis.AtriumExtensions?.attached);
    await install(owner, "Fable");
    await install(peer, "Cinder");

    for (const id of [owner, peer]) await hold(id + ":" + heldQuery);
    await query(heldQuery);
    for (const id of [owner, peer]) await sent(id + ":" + heldQuery);
    await toggle(false);
    for (const id of [peer, owner]) await release(id + ":" + heldQuery);
    await text("Cinder " + heldQuery).waitFor();
    summary.cancelledSearchRows = await text("Fable " + heldQuery).count();
    summary.searchDispatches = await page.evaluate(query => paletteLifecycle.dispatches.filter(d => d.query === query).map(d => d.owner).sort(), heldQuery);

    await toggle(true);
    await query("lifecycle-rendered");
    await text("Fable lifecycle-rendered").waitFor();
    await text("Cinder lifecycle-rendered").waitFor();
    await toggle(false);
    await paint();
    summary.renderedSearchRows = await palette.locator(".nav-palette-label").allTextContents()
      .then(labels => labels.filter(label => label.endsWith(" lifecycle-rendered")).sort());

    await toggle(true);
    await hold(peer);
    await query(">Lifecycle proof");
    await clickCommand("Cinder");
    await sent(peer);
    await toggle(false);
    await release(peer);
    await paint();
    summary.companionPresents = await screen.getByText("Local fixture", {exact: true}).count();

    await toggle(true);
    await hold(peer);
    await query(">Lifecycle proof");
    await clickCommand("Cinder");
    await sent(peer);
    await clickCommand("Fable");
    await screen.getByText("Local fixture", {exact: true}).waitFor();
    await release(peer);
    await paint();
    summary.latestTitle = await screen.getAttribute("aria-label");
    assert.equal((await sandboxTargets()).length, 2, "Chromium sees both extension command realms");

    await hold(owner);
    await query(">Lifecycle proof Fable");
    await clickCommand("Fable");
    await sent(owner);
    await toggle(false);
    summary.runningAtDisable = await running();
    await release(owner);
    await uninstall();

    await install(owner, "Fable");
    await hold(owner);
    await query(">Lifecycle proof Fable");
    await clickCommand("Fable");
    await sent(owner);
    await uninstall();
    await release(owner);
    await paint();
    summary.removedPresents = await screen.count();

    await showManager();
    await button(manager, "Stop all").click();
    await manager.getByText("All extensions and scripts were stopped.", {exact: true}).waitFor();
    summary.runningAfterStop = await running();
    await paint();
    summary.workerTargetsAfterStop = (await sandboxTargets()).length;
    summary.commandKills = await page.evaluate(() => {
      const {workers, ended} = paletteLifecycle;
      return [...workers].filter(([, realm]) => realm?.role === "command")
        .map(([id, realm]) => [realm.owner, ended.filter(killed => id === killed).length]);
    });
    summary.unreclaimed = await page.evaluate(() => {
      const {workers, ended} = paletteLifecycle;
      return [...workers].filter(([id, realm]) => realm?.owner && !ended.includes(id)).map(([, realm]) => realm.owner);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(summary, {
      cancelledSearchRows: 0, searchDispatches: [peer, owner],
      renderedSearchRows: ["Cinder lifecycle-rendered"], companionPresents: 1, latestTitle: "Fable detail",
      runningAtDisable: ["ext:" + peer], removedPresents: 0, runningAfterStop: [], workerTargetsAfterStop: 0,
      commandKills: [[peer, 1], [owner, 1], [owner, 1]], unreclaimed: []
    });
  } finally { await targets.detach(); await page.close(); await server.close(); }
  console.log("PASS palette provider retirement, peer search and commands, and real sandbox worker cleanup");
};
