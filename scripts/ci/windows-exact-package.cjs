"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const [phase, port, output, version, expectedAdapter, expectGpu] = process.argv.slice(2);
assert.ok(["0","1"].includes(expectGpu));
assert.ok(["save", "reopen"].includes(phase));
assert.match(port, /^\d+$/);
const endpoint = "http://127.0.0.1:" + port;
const root = path.resolve(__dirname, "../..");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const outputFile = name => path.join(output, name);
const write = (name, value) => fs.writeFileSync(outputFile(name), JSON.stringify(value, null, 2) + "\n");
async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await wait(150);
  } while (Date.now() < deadline);
  throw Error(message);
}
async function request(route) {
  try {
    const result = await fetch(endpoint + route, {signal:AbortSignal.timeout(2500)});
    if (result.ok) return result.json();
  } catch (error) {
    if (!(error instanceof TypeError || error.name === "TimeoutError")) throw error;
  }
  return null;
}
function connect(address) {
  assert.match(address, new RegExp("^ws://127\\.0\\.0\\.1:" + port + "/"));
  const socket = new WebSocket(address);
  let serial = 0;
  const requests = new Map(), errors = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("WebView2 DevTools timed out")), 8000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, {once:true});
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("WebView2 DevTools socket failed")); }, {once:true});
  });
  socket.addEventListener("message", ({data}) => {
    const event = JSON.parse(data);
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
    const match = requests.get(event.id);
    if (!match) return;
    requests.delete(event.id);
    clearTimeout(match.timer);
    if (event.error) match.reject(Error(event.error.message));
    else match.resolve(event.result);
  });
  async function send(method, params = {}, timeout = 12000) {
    await ready;
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { requests.delete(id); reject(Error(method + " timed out")); }, timeout);
      requests.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression, timeout) {
    const result = await send("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true}, timeout);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  return {send, evaluate, errors, close:() => socket.close()};
}
const js = (fn, ...args) => "(" + fn.toString() + ")(" + args.map(x => JSON.stringify(x)).join(",") + ")";

function boardReady() {
  const H = globalThis.AtriumNavHost;
  if (!H || window.__atriumOpeningProject || H.project()?.id !== "sensor-interface" || !H.folderProject?.()) return null;
  if (H.currentId() !== "pcb" && H.documentRefs().some(d => d.id === "pcb")) H.selectDocument("pcb");
  const d = H.project().documents.find(d => d.id === "pcb" && d.kind === "pcb");
  if (!d || !d.items.some(i => i.id === "gndpour" && i.kind === "polygon")) return null;
  if (H.doc()?.id !== d.id) H.selectDocument(d.id);
  return {name:d.name, id:d.id, items:d.items.length};
}
function renderer() {
  const H = AtriumNavHost, G = globalThis.AtriumCanvasGPU, I = H.view().internals();
  const status = G?.status(I), stats = G?.stats(I);
  return {device:stats?.renderer || null, status, preference:AtriumPrefs.get("display.renderer"),
    backing:[H.canvas().width,H.canvas().height], frames:stats?.acc?.frames || 0, visibility:document.visibilityState};
}
function physicalGpu(row) {
  return row?.preference === "auto" && row.status?.renderer === "gpu" && row.status.forced === null &&
    row.frames > 0 && row.device?.includes(expectedAdapter) && !/swiftshader|warp|llvmpipe|software/i.test(row.device);
}
async function copper() {
  const H = AtriumNavHost, P = await AtriumLazy.need("AtriumPolygonPour"), d = H.doc();
  const regions = (d.pcbDrawing?.pours || []).filter(r => r.polygon === "gndpour");
  const rings = regions.map(r => P.rings(r));
  if (!regions.length || !rings.some(r => r.length) || !P.current(d,H.defs(),{project:H.project()})) return null;
  const data = new TextEncoder().encode(JSON.stringify(regions.map((r,i) => [r.polygon,r.layer,r.net,rings[i]])));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data)),x => x.toString(16).padStart(2,"0")).join("");
  return {regions:regions.length, hash, worker:P.reuse.last};
}

async function main() {
  const report = {phase};
  const save = () => write(phase + ".json", report);
  const runtime = await until(() => request("/json/version"), "No native DevTools endpoint");
  assert.match(runtime.Browser, /(?:Edg|Chrome|WebView2)\//);
  report.runtime = runtime.Browser;
  const target = await until(async () => (await request("/json/list"))?.find(t => t.type === "page" &&
    /^https:\/\/app\.waffle\.example\/index\.html(?:[?#]|$)/.test(t.url)), "No native editor document target");
  const client = connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    report.board = await until(() => client.evaluate(js(boardReady)), "The native persisted project did not open");
    assert.equal(report.board.name, "Sensor board");
    const about = await client.evaluate(js(async expected => {
      await AtriumNavHost.act("about");
      for (let attempt = 0; attempt < 40; attempt++) {
        const dialog = document.querySelector("dialog.about-dialog[open]");
        if (dialog) {
          const text = dialog.querySelector(".about-version")?.textContent;
          const renderer = dialog.querySelector(".about-renderer")?.textContent || null;
          dialog.close();
          const served = (await (await fetch("VERSION")).text()).trim();
          return {served,text,renderer,expected};
        }
        await new Promise(resolve => setTimeout(resolve,100));
      }
      throw Error("The About dialog did not open");
    },version));
    assert.equal(about.served, version);
    assert.ok(about.text?.startsWith(version + " ") && about.text.includes("Butter Preview"), "Displayed About version does not match");
    report.about = about;
    report.hardware = await client.evaluate(js(renderer));
    // The presentation state can change after Win32 samples the desktop.
    // Record actual renderer evidence without blocking the functional smoke.
    for (let i = 0; expectGpu === "1" && i < 24 && !physicalGpu(report.hardware); i++) {
      await wait(150);
      report.hardware = await client.evaluate(js(renderer));
    }
    report.physicalGpuObserved = Boolean(physicalGpu(report.hardware));
    save();

    if (phase === "save") {
      await client.evaluate(js(async () => {
        const H = AtriumNavHost;
        AtriumPrefs.set("general.autosave", false);
        const P = await AtriumLazy.need("AtriumPolygonPour");
        if (P.current(H.doc(),H.defs(),{project:H.project()})) throw Error("The fixture unexpectedly starts with a certified fill");
        H.act("repour");
        return true;
      }));
      report.copper = await until(async () => {
        const result = await client.evaluate(js(copper));
        return result?.worker?.solved > 0 && result.worker.worker > 0 ? result : null;
      }, "Repour All did not publish fresh copper using the background worker", 60000);
      assert.equal(await client.evaluate(js(() => AtriumNavHost.saveProject({download:false})), 60000), true,
        "Native Save failed");
    } else {
      report.copper = await until(() => client.evaluate(js(copper)), "The saved copper was unavailable after a fresh native launch");
      const prior = JSON.parse(fs.readFileSync(outputFile("save.json"), "utf8"));
      assert.equal(report.copper.hash, prior.copper.hash, "Reopened stored copper differs from the save");
      assert.equal(report.copper.regions, prior.copper.regions);
      assert.equal(report.copper.worker, null, "The reopened copper must be read from storage");
      save();

      if (report.physicalGpuObserved && report.hardware.visibility === "visible") {
        // Reuse the existing small pour-board checks and recovery paths.
        for (const file of ["tests/pcb/dense-board.js", "tests/canvas/gpu-pixels.js"])
          await client.evaluate(fs.readFileSync(path.join(root,file), "utf8"));
        const pixels = await client.evaluate(js(async () => {
          const result = await atriumGpuPixels({boards:["pours"]});
          delete result.images;
          return result;
        }), 180000);
        write("gpu-pixels.json", pixels);
        assert.ok(!pixels.skipped && pixels.boards?.pours, "The existing GPU pixel oracle did not execute");
        assert.deepEqual(pixels.failures, []);
        report.gpuOracle = {status:"pass",boards:Object.keys(pixels.boards),recovery:pixels.robust || null};
      } else {
        report.gpuOracle = {status:"unverified",reason:"The visible native board did not expose a qualified physical GPU."};
      }
    }
    assert.deepEqual(client.errors, []);
    report.pass = true;
    save();
  } catch (error) {
    report.pass = false;
    report.error = String(error.stack || error);
    save();
    throw error;
  } finally {
    client.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
