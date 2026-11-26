"use strict";
// Pressing 3 on real imported Altium boards: the 3D view must answer at once and never freeze the page.
// Before the fix, the first 3 after any edit repoured every stale pour and ran the pour clearance check
// on the main thread (3.3 s on GargantuRAM, 3.5 s on the CM4/CM5 shim in WKWebView), and covered copper
// drew as bare copper, so a board with a ground pour looked solid gold.
//
// Budgets (Chromium, headless):
//   LONG_TASK 100 ms: the longest main-thread task from the key press until the view is complete. 100 ms
//     is where a response stops feeling immediate (RAIL); the time-sliced build measures 0-60 ms here and
//     55-80 ms in WKWebView on GargantuRAM, the densest public board.
//   FIRST_FRAME 1000 ms: key press to the first drawn 3D frame, including loading view3d.js and the STEP
//     geometry module from disk on the first press (about 40-70 ms measured; the margin is for slow CI).
// Boards: the vendored PiDP-11 I/O expander always; GargantuRAM (11k objects, 236 parts, 44 STEP bodies)
// when tests/altium-fidelity/fetch.py has cached it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const LONG_TASK = 100, FIRST_FRAME = 1000;

function openFixtures() {
  const list = [{name: "PiDP-11 I/O expander", file: path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc")}];
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "waffle", "altium-fidelity");
  const fixture = require("../altium-fidelity/fixtures.json").projects.find(p => p.id === "garganturam");
  const member = fixture?.assets.flatMap(a => a.members || a).find(a => /\.pcbdoc$/i.test(a.path || ""));
  const dense = member && path.join(cache, fixture.id, fixture.revision, path.basename(member.path));
  if (dense && fs.existsSync(dense)) list.push({name: "GargantuRAM", file: dense, dense: true});
  else console.log("SKIP browser 3D open on GargantuRAM: run tests/altium-fidelity/fetch.py to cache it");
  return list;
}

const APP = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const VIEWPORT = {width: 1380, height: 860};

const CASES = {
  demand: {check: checkDemand},
  navigation: {check: checkNavigation, options: {viewport: VIEWPORT, hasTouch: true, reducedMotion: "reduce"}},
  open: {check: checkOpen, options: {viewport: VIEWPORT}, fixtures: openFixtures},
  folder: {check: checkFolder, fixtures: () => [folderFixture()]}
};

module.exports = async function view3d(browser, cases = ["open"]) {
  for (const name of cases) {
    assert.ok(Object.hasOwn(CASES, name), "Unknown 3D case: " + name);
    const {check, options, fixtures} = CASES[name];
    for (const fixture of fixtures ? fixtures() : [undefined]) {
      const page = await browser.newPage(options), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await check(page, fixture);
        assert.deepEqual(errors, [], "No page errors in 3D " + name);
      } finally {
        await page.close();
      }
    }
  }
};

async function checkOpen(page, board) {
  await page.addInitScript(() => localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1,
    values: {"general.efficiency": "always", "appearance.animations": "off"}})));
  await page.goto(APP);
  const choose = page.waitForEvent("filechooser");
  await page.locator("dialog.sp-dialog[open]").getByRole("button", {name: "Import from Altium or KiCad…", exact: true}).click();
  await (await choose).setFiles([board.file]);
  await page.getByRole("article", {name: "Import fidelity report"}).waitFor({timeout: 120000});
  const id = await page.evaluate(() => AtriumNavHost.project().documents.find(d => d.kind === "pcb").id);
  await page.locator('#document-tabs [data-tab="' + id + '"]').click();
  await page.waitForFunction(id => {
    const host = AtriumNavHost, frame = host.view().internals();
    return host.currentId() === id && frame.frame()?.[0] === host.doc() && !frame.openingOverview();
  }, id);
  if (!await page.evaluate(() => { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); })) {
    console.log("SKIP browser 3D open on " + board.name + ": no WebGL in this Chromium");
    return;
  }
  // An edit leaves the imported pours stale, which is what made the first 3 repour the whole board.
  // Moved behind the editor's back, so no live repour can settle the pours before 3 is pressed.
  await page.evaluate(() => { AtriumNavHost.doc().items.find(i => i.kind === "part").x += 0.5; });
  const nudge = dx => page.evaluate(dx => { const part = AtriumNavHost.doc().items.find(i => i.kind === "part"); AtriumNavHost.edit(() => { part.x += dx; }); }, dx);
  await page.evaluate(() => {
    const P = globalThis.__open3d = {t0: 0, first: 0, long: [], meshes: 0};
    const collect = entries => { for (const e of entries) if (P.t0 && e.startTime + e.duration > P.t0) P.long.push(Math.round(e.duration)); };
    const observer = new PerformanceObserver(list => collect(list.getEntries()));
    observer.observe({type: "longtask"});
    P.tasks = () => {collect(observer.takeRecords()); return P.long;};
    addEventListener("keydown", e => { if (e.key === "3") P.t0 = performance.now(); }, true);
    const frame = () => {
      const v = globalThis.Atrium3D && [...Atrium3D.viewers.values()][0];
      if (P.t0 && !P.first && v?.stats?.().draws > 0) P.first = performance.now() - P.t0;
      if (!P.first) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.locator("#canvas").focus();
  await page.keyboard.press("3");
  await page.waitForFunction(() => globalThis.Atrium3D?.isOpen() && __open3d.first > 0, null, {timeout: 30000});
  const viewer = () => "[...Atrium3D.viewers.values()][0]";
  await page.waitForFunction(v => { const view = eval(v); return view.stats && !view.pending(); }, viewer(), {timeout: 60000});
  const open = await page.evaluate(() => ({first:__open3d.first, long:__open3d.tasks(), status:document.getElementById("status").textContent,
    parts:AtriumNavHost.doc().items.filter(i => i.kind === "part").length}));
  const longest = Math.max(0, ...open.long);
  console.log("3D open on " + board.name + ": first frame " + Math.round(open.first) + " ms, longest task " + longest + " ms");
  assert.ok(longest <= LONG_TASK, board.name + ": pressing 3 blocks the page for " + longest + " ms (budget " + LONG_TASK + " ms)");
  assert.ok(open.first <= FIRST_FRAME, board.name + ": the first 3D frame took " + Math.round(open.first) + " ms (budget " + FIRST_FRAME + " ms)");
  assert.match(open.status, new RegExp("3D layout mode · " + open.parts + " components"), "the status line counts every placed component");

  // The first 3D camera looks straight down over the 2D framing: the board gains depth, nothing jumps.
  const framing = await page.evaluate(v => {
    const view = eval(v), cam = view.camera(), M = Atrium3D.math, f = M.frame(cam), sc = view.scene(), c = view.canvas;
    const board = sc.batches.find(b => b.kind === "board").instances[0].box, w = c.clientWidth, h = c.clientHeight;
    const m = M.matrices(cam, w / h, sc.sphere), corners = [];
    for (const x of [board[0], board[3]]) for (const y of [board[1], board[4]]) corners.push(M.project(m.vp, [x, y, board[5]], w, h));
    const v2 = AtriumNavHost.view().camera();
    return {fwd: f.fwd, corners, w, h, v2, target: cam.target};
  }, viewer());
  assert.ok(framing.fwd[2] < -0.9999, "the first 3D view looks straight down: " + framing.fwd);
  assert.ok(Math.abs(framing.target[0] - framing.v2.cx) < 1e-6 && Math.abs(framing.target[1] + framing.v2.cy) < 1e-6, "centred where the 2D view was");
  const xs = framing.corners.map(p => p[0]), ys = framing.corners.map(p => p[1]);
  assert.ok(Math.min(...xs) > -2 && Math.max(...xs) < framing.w + 2 && Math.min(...ys) > -2 && Math.max(...ys) < framing.h + 2, "the board fits the 3D view as it fitted the 2D view");
  assert.ok(Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * framing.w / framing.h) > framing.w * 0.4, "and fills it");

  // No focus ring after the shortcut; the canvas keeps the grab cursor and the toolbar does not.
  const chrome = await page.evaluate(() => {
    const c = document.querySelector(".v3d-canvas"), b = document.querySelector(".v3d-bar .v3d-btn");
    return {focused: document.activeElement === c, ring: getComputedStyle(c).boxShadow, outline: getComputedStyle(c).outlineStyle,
      canvas: getComputedStyle(c).cursor, button: getComputedStyle(b).cursor, bar: getComputedStyle(b.parentElement).cursor};
  });
  assert.ok(chrome.focused, "the 3D canvas takes focus");
  assert.equal(chrome.ring, "none", "no focus ring after pressing 3");
  assert.equal(chrome.outline, "none");
  assert.equal(chrome.canvas, "grab");
  assert.ok(!/grab/.test(chrome.button + chrome.bar), "the 3D toolbar has no grab cursor");

  // Non-blank, and covered copper takes the mask colour: from the top, board pixels are mostly
  // mask green with copper only at the mask openings (the pour drew solid gold before).
  const pixels = await page.evaluate(v => {
    const view = eval(v), gl = view.R.gl;
    view.command("view3d-top"); view.renderNow();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const bg = [px[0], px[1], px[2]];
    let board = 0, green = 0, gold = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 12) continue;
      board++;
      if (g > r + 12 && g > b + 12) green++;
      else if (r > 150 && r > g + 15 && g > b + 25) gold++;
    }
    return {share: board / (w * h), green: green / board, gold: gold / board};
  }, viewer());
  console.log("3D pixels on " + board.name + ": " + JSON.stringify(pixels));
  assert.ok(pixels.share > 0.1, board.name + ": the 3D view shows the board (" + (pixels.share * 100).toFixed(1) + " % of the canvas)");
  assert.ok(pixels.green > 0.4, board.name + ": covered copper and laminate show the mask colour");
  assert.ok(pixels.gold < pixels.green / 3, board.name + ": bare copper only where the mask opens");

  // 2 then 3 again: the built geometry is cached, so the view returns complete with no long task,
  // at the camera the user left it at.
  const turned = {target: [framing.target[0] + 3, framing.target[1] - 2, 1], dist: 90, yaw: -70, pitch: 32, fov: 30};
  await page.evaluate(([v, c]) => eval(v).camera(c), [viewer(), turned]);
  await page.keyboard.press("2");
  await page.waitForFunction(() => !Atrium3D.isOpen());
  await page.evaluate(() => { __open3d.long = []; __open3d.t0 = 0; });
  await page.keyboard.press("3");
  await page.waitForFunction(() => Atrium3D.isOpen());
  const again = await page.evaluate(v => ({pending:eval(v).pending(), long:__open3d.tasks()}), viewer());
  assert.equal(again.pending, null, "reopening uses the cached copper and bodies");
  assert.deepEqual(await page.evaluate(v => eval(v).camera(), viewer()), turned, "3 returns to the last 3D camera");
  assert.ok(Math.max(0, ...again.long) <= LONG_TASK, "reopening does not block");

  // Pressing 2 while copper is still building stops the job: an edit invalidates the cache, then 3 and 2.
  await page.keyboard.press("2");
  await page.evaluate(() => {
    const S = globalThis.AtriumSTEP;
    globalThis.AtriumSTEP = Object.freeze({...S, mesh(...a) { __open3d.meshes++; return S.mesh(...a); }});
  });
  await nudge(-0.5); // a real edit: the cached copper is out of date
  await page.keyboard.press("3");
  await page.keyboard.press("2");
  await page.waitForFunction(() => !Atrium3D.isOpen());
  const before = await page.evaluate(() => __open3d.meshes);
  await page.waitForTimeout(400); // Observe actual background work after cancellation.
  assert.equal(await page.evaluate(() => __open3d.meshes), before, "pressing 2 cancels the copper build");
}

async function checkDemand(page) {
  const requests = [];
  let release;
  const delay = new Promise(done => {release = done;});
  page.on("request", r => { if (r.url().endsWith("/view3d.js")) requests.push(r.url()); });
  try {
    await page.addInitScript(() => localStorage.setItem("atrium.prefs", JSON.stringify({
      format:"atrium-prefs",version:1,values:{"general.startPage":"never","general.efficiency":"always"}
    })));
    await page.route("**/view3d.js", async route => {await delay; await route.continue();});
    await page.goto(APP);
    await page.evaluate(async () => {
      const host = AtriumNavHost, p = AtriumParts.example(), sheet = p.documents.find(d => d.kind === "schematic");
      await host.replaceProject({...p,documents:[sheet]}, {force:true,dirty:false}); host.act("view-3d");
      AtriumPower.host({occluded:true});
      await host.replaceProject(p, {force:true,dirty:false}); host.act("view-3d");
      AtriumPower.host({occluded:false});
    });
    assert.equal(requests.length, 0, "a schematic and an occluded PCB leave the 3D viewer cold");
    const first = page.waitForRequest("**/view3d.js");
    await page.locator("#canvas").focus(); await page.keyboard.press("3"); await first;
    await page.keyboard.press("2"); release();
    await page.waitForFunction(() => globalThis.AtriumLazy?.has(["Atrium3D","AtriumSTEP","AtriumFlexFold"]));
    assert.equal(await page.evaluate(() => Atrium3D.isOpen()), false, "a delayed 3 cannot override a newer 2");
    await page.keyboard.press("3");
    await page.waitForFunction(() => {
      const view = [...Atrium3D.viewers.values()][0];
      return !!(view?.fallback || view?.stats?.().draws > 0);
    });
    await page.evaluate(() => { globalThis.demandViewer = [...Atrium3D.viewers.values()][0]; });
    await page.keyboard.press("2");
    await page.waitForFunction(() => !Atrium3D.isOpen());
    const closed = await page.evaluate(() => {
      const view = globalThis.demandViewer;
      delete globalThis.demandViewer;
      return {closed:view.closed, connected:view.root.isConnected, fallback:view.fallback, freed:view.freed};
    });
    assert.ok(closed.closed && !closed.connected, "returning to 2D removes the pane");
    if (!closed.fallback) assert.ok(closed.freed?.buffers > 0 && closed.freed.live === 0, "returning to 2D releases the 3D buffers");
    assert.equal(requests.length, 1);
  } finally { release(); }
}

async function checkNavigation(page) {
  await page.goto(APP);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => !AtriumNavHost.isStarter());
  const viewMenu = page.locator('.work-menu[data-menu="view"] > summary');
  await viewMenu.click();
  await page.getByRole("menuitemcheckbox", {name:"3D Layout Mode", exact:true}).click();
  const canvas = page.getByRole("img", {name:/^3D view of Sensor board/});
  const toolbar = page.getByRole("toolbar", {name:"3D view", exact:true});
  await page.waitForFunction(() => globalThis.Atrium3D?.isOpen());
  if (!await page.evaluate(() => Atrium3D.stats().webgl)) {
    const supportsViewer = await page.evaluate(() => {
      const make = () => document.createElement("canvas");
      const gl = make().getContext("webgl2") || make().getContext("webgl");
      const capable = gl && (typeof gl.drawElementsInstanced === "function" ||
        (gl.getExtension("ANGLE_instanced_arrays") && gl.getExtension("OES_element_index_uint")));
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return !!capable;
    });
    assert.equal(supportsViewer,false,"a supported WebGL context must open the 3D viewer");
    await page.getByRole("heading",{name:"3D view needs WebGL"}).waitFor();
    console.log("SKIP browser 3D navigation: this Chromium host has no supported WebGL context; fallback verified");
    return;
  }
  const buttons = Object.fromEntries([ ["top","View from top"], ["bottom","View from bottom"], ["flip","Flip board"],
    ["fit","Fit board"], ["options","View options"], ["2d","Back to 2D layout"] ].map(([k,name]) => [k,toolbar.getByRole("button", {name,exact:true})]));
  const camera = () => page.evaluate(() => [...Atrium3D.viewers.values()][0].camera());
  const selected = () => page.evaluate(() => AtriumNavHost.selection());
  const focus = () => canvas.evaluate(c => c === document.activeElement);
  const beforeItems = await page.evaluate(() => JSON.stringify(AtriumNavHost.doc().items));
  const close = (a,b,tol=.00001) => Math.abs(a-b)<tol;

  assert.ok(await focus(), "the board viewer takes focus on open");
  assert.equal(await page.locator("#canvas").getAttribute("aria-hidden"), "true");
  const box = await canvas.boundingBox(), x = Math.round(box.x + box.width*.4), y = Math.round(box.y + box.height*.42);
  await page.mouse.move(x,y);
  assert.equal(await page.evaluate(() => typeof AtriumCamera.wheelPacket), "function", "first 3D open already has the shared wheel owner");
  const observedWheel = async (host, dy, count) => {
    await page.mouse.wheel(0, dy);
    await page.waitForFunction(({host, count}) => host.packets.length >= count, {host, count});
  };
  // WKWebView can deliver exactly the same DOM packet for a precise scroll and a notch.
  const wheelHost = await page.evaluateHandle(() => {
    const v=[...Atrium3D.viewers.values()][0], packets=[];
    const state={marked:false, packets};
    const native = e => e.isTrusted && state.marked && e.deltaMode===0 && e.deltaY===-40 ?
      [{deltaY:e.deltaY,timeStamp:e.timeStamp}] : null;
    const listener = e => packets.push([e.isTrusted,e.deltaMode,e.deltaX,e.deltaY,e.wheelDeltaY]);
    v.canvas.addEventListener("wheel",listener);
    globalThis.__waffleWheelNotches=native;
    globalThis.__waffleIsWheelNotch=e=>!!native(e);
    state.close=()=>{
      v.canvas.removeEventListener("wheel",listener);
      delete globalThis.__waffleWheelNotches;delete globalThis.__waffleIsWheelNotch;
    };
    return state;
  });
  try {
    const before=await camera();
    await observedWheel(wheelHost, -40, 1);
    const precise=await camera();
    assert.equal(precise.dist,before.dist,"a trusted precise 40-pixel wheel pans even with a notch-like DOM delta");
    assert.notDeepEqual(precise.target,before.target);
    const anchor=await page.evaluate(([x,y])=>{
      const v=[...Atrium3D.viewers.values()][0],c=v.canvas,r=c.getBoundingClientRect();
      const {o,d}=v.pickAt(x-r.left,y-r.top,false).ray;
      return o.map((p,i)=>p+d[i]*v.camera().dist);
    },[x,y]);
    await wheelHost.evaluate(state=>{state.marked=true;});
    await observedWheel(wheelHost, -40, 2);
    const notch=await camera();
    assert.ok(close(notch.dist/precise.dist,Math.exp(-40*.0015)),"the marked detent keeps 3D wheel sensitivity");
    const spot=await page.evaluate(anchor=>{
      const v=[...Atrium3D.viewers.values()][0],c=v.canvas,r=c.getBoundingClientRect(),M=Atrium3D.math;
      const vp=M.matrices(v.camera(),c.clientWidth/c.clientHeight,v.scene().sphere).vp;
      const at=M.project(vp,anchor,c.clientWidth,c.clientHeight);
      return [at[0]+r.left,at[1]+r.top];
    },anchor);
    assert.ok(Math.hypot(spot[0]-x,spot[1]-y)<.1,"the marked detent preserves its perspective anchor");
    assert.deepEqual(await wheelHost.evaluate(state=>state.packets),[[true,0,0,-40,120],[true,0,0,-40,120]],
      "the two trusted Chromium packets have the same DOM values as the measured native ambiguity");
  } finally {
    await wheelHost.evaluate(state=>state.close());
    await wheelHost.dispose();
  }
  const units=await page.evaluate(([x,y])=>{
    const v=[...Atrium3D.viewers.values()][0];
    return [WheelEvent.DOM_DELTA_LINE,WheelEvent.DOM_DELTA_PAGE].map(deltaMode=>{
      const before=v.camera().dist;
      v.canvas.dispatchEvent(new WheelEvent("wheel",{deltaMode,deltaY:-1,clientX:x,clientY:y,bubbles:true,cancelable:true}));
      return v.camera().dist/before;
    });
  },[x,y]);
  assert.ok(close(units[0],Math.exp(-16*.0015))&&close(units[1],Math.exp(-400*.0015)),"line and page wheel units keep their 3D zoom scale");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id === "canvas"), false);
  await canvas.focus();
  await page.keyboard.press("F6");
  assert.equal(await focus(), false, "F6 leaves the viewport");
  for (let i=0; i<8 && !await focus(); i++) await page.keyboard.press("F6");
  assert.ok(await focus(), "F6 returns to the visible 3D viewport");
  await page.evaluate(() => AtriumShell.dialog({title:"Focus return probe",body:[document.createElement("p")],actions:[{label:"Close"}]}));
  await page.getByRole("dialog",{name:"Focus return probe"}).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement.classList.contains("v3d-canvas"));

  await buttons.top.click(); assert.equal((await camera()).pitch,90);
  await buttons.bottom.click(); assert.equal((await camera()).pitch,-90);
  await buttons.flip.click(); assert.equal((await camera()).pitch,90);
  await canvas.focus();
  const left = await camera(); await page.keyboard.press("ArrowLeft");
  assert.ok(close((await camera()).yaw-left.yaw,15),"an arrow orbits by 15°");
  await page.keyboard.press("Shift+ArrowRight");
  assert.ok(close((await camera()).yaw-left.yaw,-30),"Shift+arrow orbits by 45°");
  const mouseDrag = async (button, shift=false, delta=[24,17]) => {
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(x,y); await page.mouse.down({button});
    await page.mouse.move(x+delta[0],y+delta[1],{steps:4}); await page.mouse.up({button});
    if (shift) await page.keyboard.up("Shift");
  };
  let before = await camera(); await mouseDrag("left"); let after = await camera();
  assert.ok(close(before.yaw-after.yaw,8.4) && after.dist===before.dist && JSON.stringify(after.target)===JSON.stringify(before.target), "left drag orbits");
  for (const [button,shift] of [["left",true],["right",false],["middle",false]]) {
    before=await camera(); await mouseDrag(button,shift); after=await camera();
    assert.ok(after.yaw===before.yaw && after.dist===before.dist && JSON.stringify(after.target)!==JSON.stringify(before.target),button+" drag pans");
  }
  await page.mouse.move(x,y); before=await camera(); await page.mouse.wheel(13,7);
  await page.waitForFunction(target => JSON.stringify([...Atrium3D.viewers.values()][0].camera().target)!==target, JSON.stringify(before.target));
  after=await camera(); assert.equal(after.dist,before.dist,"precision scroll pans without changing zoom");
  await page.mouse.wheel(0,-120);
  await page.waitForFunction(dist => [...Atrium3D.viewers.values()][0].camera().dist<dist, after.dist);
  // Chromium drops empty wheel commands. Adapt one delivered trusted packet to the
  // zero DOM delta that WKWebView can produce when it coalesces opposite marked steps.
  const native = await page.evaluateHandle(() => {
    const v=[...Atrium3D.viewers.values()][0], original=v.camera();
    const state={grouped:false,deliverSteps:true,packets:[]};
    const capture=e=>{
      if (e.isTrusted && state.grouped) Object.defineProperty(e,"deltaY",{value:0});
      state.packets.push([e.isTrusted,e.deltaMode,e.deltaX,e.deltaY]);
    };
    const steps=e=>!e.isTrusted||!state.deliverSteps?null:
      (state.grouped?[-40,40]:[e.deltaY]).map(deltaY=>({deltaY,timeStamp:e.timeStamp}));
    v.canvas.addEventListener("wheel",capture,true);
    globalThis.__waffleWheelNotches=steps;
    globalThis.__waffleIsWheelNotch=e=>!!steps(e);
    v.camera({dist:v.scene().sphere.r*.01});
    const minimum=v.camera();
    state.reset=()=>v.camera(minimum);
    state.close=()=>{
      v.canvas.removeEventListener("wheel",capture,true);
      delete globalThis.__waffleWheelNotches;delete globalThis.__waffleIsWheelNotch;
      v.camera(original);
    };
    return state;
  });
  try {
    const minimum=await camera();
    await observedWheel(native, -40, 1);
    assert.equal((await camera()).dist,minimum.dist,"inward detent at the near distance limit clamps");
    await observedWheel(native, 40, 2);
    const separate=await camera();
    assert.ok(close(separate.dist/minimum.dist,Math.exp(40*.0015)),"separate outward detent leaves the limit");
    await native.evaluate(state=>{state.reset();state.grouped=true;});
    await observedWheel(native, 1, 3);
    const grouped=await camera();
    assert.deepEqual(grouped,separate,"opposing native notches in one zero-delta packet match separate deflections");
    await native.evaluate(state=>{state.reset();state.deliverSteps=false;});
    await observedWheel(native, 1, 4);
    assert.deepEqual(await camera(),minimum,"a zero packet without native steps cannot move the camera");
    assert.deepEqual(await native.evaluate(state=>state.packets),[
      [true,0,0,-40],[true,0,0,40],[true,0,0,0],[true,0,0,0]
    ]);
  } finally {
    await native.evaluate(state=>state.close());
    await native.dispose();
  }
  assert.equal(await page.locator(".nav-menu-portal .nav-menu").count(),0,"secondary drag stays in 3D");
  await buttons.fit.click();
  assert.ok((await camera()).dist>after.dist*.9,"the Fit button frames the board");

  await buttons.top.click();
  const parts = await page.evaluate(() => {
    const v=[...Atrium3D.viewers.values()][0], c=v.canvas, b=c.getBoundingClientRect(), M=Atrium3D.math;
    const vp=M.matrices(v.camera(),c.clientWidth/c.clientHeight,v.scene().sphere).vp;
    return v.scene().parts.flatMap(p => {
      const at=M.project(vp,p.box.slice(0,3).map((x,i)=>(x+p.box[i+3])/2),c.clientWidth,c.clientHeight);
      return at && v.pickAt(...at,false).inst?.id === p.id ? [{id:p.id, at:[b.left+at[0],b.top+at[1]]}] : [];
    });
  });
  assert.ok(parts.length>=2);
  await page.mouse.click(...parts[0].at); assert.deepEqual(await selected(),[parts[0].id]);
  await page.keyboard.down("Shift"); await page.mouse.click(...parts[1].at); await page.keyboard.up("Shift");
  assert.deepEqual(await selected(),parts.slice(0,2).map(p=>p.id));
  before=await camera(); await page.mouse.dblclick(...parts[0].at);
  assert.ok((await camera()).dist<before.dist,"double-click centres and zooms to the part");
  await buttons.fit.click();
  await page.touchscreen.tap(...parts[1].at);
  assert.deepEqual(await selected(),[parts[1].id],"a still touch selects the component");

  await page.evaluate(() => {
    globalThis.__view3dTouchEvents = [];
    const c = [...Atrium3D.viewers.values()][0].canvas;
    for (const t of ["pointerdown","pointermove","pointerup","pointercancel"]) c.addEventListener(t,e=>{
      if(e.pointerType==="touch")globalThis.__view3dTouchEvents.push([t,e.isTrusted]);
    });
  });
  const cdp=await page.context().newCDPSession(page);
  async function touch(type, points) {
    const next = {touchStart:"pointerdown",touchMove:"pointermove",touchEnd:"pointerup",touchCancel:"pointercancel"}[type];
    const first = await page.evaluate(() => __view3dTouchEvents.length);
    await cdp.send("Input.dispatchTouchEvent",{type,touchPoints:points.map(([id,x,y])=>({id,x,y}))});
    await page.waitForFunction(([i,next]) => __view3dTouchEvents.slice(i).some(([t,trusted]) => t===next && trusted), [first,next]);
  }
  const deltaTarget=(a,b)=>Math.hypot(...a.target.map((n,i)=>n-b.target[i]));
  const savedSelection=await selected();
  before=await camera();
  await touch("touchStart",[[1,x,y]]); await touch("touchMove",[[1,x+20,y+8]]);
  after=await camera(); assert.ok(after.yaw===before.yaw && after.dist===before.dist && deltaTarget(before,after)>.01,"one trusted touch pans by default");
  const anchor = await page.evaluate(([x,y]) => {
    const v=[...Atrium3D.viewers.values()][0], r=v.canvas.getBoundingClientRect(), h=v.pickAt(x-r.left,y-r.top,false);
    if (h.point) return h.point;
    const z=h.ray.o[2]>=v.scene().thickness/2 ? v.scene().thickness : 0;
    const t=(z-h.ray.o[2])/h.ray.d[2];
    return h.ray.o.map((o,i)=>o+h.ray.d[i]*(t>0?t:v.camera().dist));
  },[x+40,y+8]);
  await touch("touchStart",[[1,x+20,y+8],[2,x+60,y+8]]);
  before=await camera(); await touch("touchMove",[[1,x+20,y+8],[2,x+80,y+16]]); after=await camera();
  assert.ok(close(after.dist/before.dist,40/Math.hypot(60,8)),"two trusted contacts pinch once");
  const at = await page.evaluate(p => {
    const v=[...Atrium3D.viewers.values()][0], c=v.canvas, r=c.getBoundingClientRect(), M=Atrium3D.math;
    const [x,y]=M.project(M.matrices(v.camera(),c.clientWidth/c.clientHeight,v.scene().sphere).vp,p,c.clientWidth,c.clientHeight);
    return [r.left+x,r.top+y];
  },anchor);
  assert.ok(Math.hypot(at[0]-x-50,at[1]-y-12)<.1,"the 3D point follows the moving perspective midpoint");
  await touch("touchEnd",[[2,x+80,y+16]]);
  assert.deepEqual(await camera(),after,"lifting one finger leaves the camera in place");
  await touch("touchMove",[[1,x+26,y+12]]); before=await camera();
  assert.ok(before.yaw===after.yaw && before.dist===after.dist && deltaTarget(before,after)>.01,"the remaining finger resumes panning");
  await touch("touchCancel",[]); assert.deepEqual(await camera(),before,"cancel does not change the camera");
  assert.deepEqual(await selected(),savedSelection,"touch navigation preserves selection");

  await buttons.options.click();
  const orbit = page.getByRole("checkbox", {name:"Orbit with one finger"});
  assert.equal(await orbit.isChecked(),false);
  await orbit.check(); await orbit.press("Escape");
  assert.equal(await buttons.options.getAttribute("aria-expanded"),"false");
  before=await camera();
  await touch("touchStart",[[3,x,y]]); await touch("touchMove",[[3,x+16,y+6]]); await touch("touchEnd",[]); after=await camera();
  assert.ok(close(before.yaw-after.yaw,5.6) && before.dist===after.dist,"touch Orbit changes only the one-finger drag");
  const simulated = await page.evaluate(([x,y]) => {
    const viewer=[...Atrium3D.viewers.values()][0], c=viewer.canvas, before=viewer.camera();
    const dispatch = e => { c.dispatchEvent(e);return e.defaultPrevented; };
    const gesture = (type,scale) => dispatch(Object.assign(new Event(type,{bubbles:true,cancelable:true}),{scale,clientX:x,clientY:y}));
    const wheel = () => dispatch(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-18,clientX:x,clientY:y}));
    const prevented=[gesture("gesturestart",1),gesture("gesturechange",1.25),wheel(),gesture("gesturecancel",1.25)];
    const after=viewer.camera(); prevented.push(wheel());
    return {prevented, gesture:after.dist/before.dist, afterCancel:viewer.camera().dist/after.dist};
  },[x,y]);
  assert.ok(simulated.prevented.every(Boolean) && close(simulated.gesture,.8) && close(simulated.afterCancel,Math.exp(-.18)), "WebKit signal and Ctrl-wheel zoom once, then cancel releases the input");

  await page.evaluate(() => AtriumLazy.need("AtriumKeymapPresets"));
  // Some profiles display the fit-objects chord and also accept the native Fit Document shortcut.
  const profiles = {
    altium: ["V F", "Mod+0"], classic: ["V F"], kicad: ["Home"], vscode: ["V F", "Mod+0"],
    allegro: ["F2"], modern: ["Mod+0"], rts: ["V F", "Mod+0"]
  };
  const mod = await page.evaluate(() => AtriumKeymap.mac ? "Meta+" : "Control+");
  for (const [profile, shortcuts] of Object.entries(profiles)) {
    const printed=await page.evaluate(([profile,key]) => { AtriumKeymap.setPreset(profile);return AtriumKeymap.display(key); },[profile,shortcuts[0]]);
    assert.deepEqual(await buttons.fit.evaluate(b=>[
      b.dataset.tooltipLabel,AtriumKeymap.display(b.dataset.tooltipShortcut)
    ]),["Fit board",printed]);
    await canvas.focus();
    await page.keyboard.press("0"); assert.equal((await camera()).pitch,90,profile+" Top");
    await page.keyboard.press("9"); assert.equal((await camera()).pitch,-90,profile+" Bottom");
    await page.keyboard.press("f"); assert.equal((await camera()).pitch,90,profile+" Flip");
    const fitted=(await camera()).dist;
    for (const key of shortcuts) {
      await page.evaluate(() => { const view=[...Atrium3D.viewers.values()][0]; view.camera({dist:view.camera().dist/2}); });
      for (const chord of key.split(" ")) await page.keyboard.press(chord.replace("Mod+",mod));
      assert.ok(close((await camera()).dist,fitted),profile+" Fit via "+key);
    }
    await page.keyboard.press("2"); assert.equal(await canvas.count(),0,profile+" 2D");
    assert.equal(await page.locator("#canvas").evaluate(c=>c===document.activeElement && c.tabIndex===0 && !c.hasAttribute("aria-hidden")),true);
    await page.keyboard.press("3"); await canvas.waitFor(); assert.ok(await focus(),profile+" 3D");
  }
  await buttons.options.click();
  const options=page.getByRole("dialog",{name:"3D view options"});
  await options.getByRole("checkbox",{name:"Copper",exact:true}).check();
  await options.getByRole("checkbox",{name:"Silkscreen",exact:true}).check();
  await page.waitForFunction(() => [...Atrium3D.viewers.values()][0].scene().hasLayers);
  await page.keyboard.press("Escape");
  await canvas.focus();
  const draw = await page.evaluate(async () => {
    const v=[...Atrium3D.viewers.values()][0], frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
    await frame(); await frame();
    const scene=v.scene(), render=v.R.draw;
    let frames=0;
    v.R.draw=(...args)=>{frames++;return render(...args);};
    try {
      const e=new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true,cancelable:true});
      v.canvas.dispatchEvent(e);
      await frame(); await frame();
      const during=frames;
      await new Promise(resolve=>setTimeout(resolve,250));
      return {action:during,idle:frames-during,sameScene:v.scene()===scene};
    }finally{v.R.draw=render;}
  });
  assert.deepEqual(draw,{action:1,idle:0,sameScene:true},"the camera redraws once, reuses the scene and then stays idle");
  await buttons.top.click();
  const near = await camera();
  await mouseDrag("left",false,[36,-22]);
  const oblique = await camera();
  assert.ok(oblique.yaw !== near.yaw && oblique.pitch < near.pitch && oblique.dist === near.dist,
    "a trusted orbit from Top changes the angle and keeps framing distance");
  await buttons.top.click();
  assert.deepEqual(await camera(), near, "Top returns to the same fitted camera");
  const hidden = await page.evaluate(async () => {
    const v = [...Atrium3D.viewers.values()][0], render = v.R.draw;
    let count = 0;
    v.R.draw = (...args) => { count++; return render(...args); };
    try {
      AtriumPower.host({occluded:true});
      v.invalidate();
      await new Promise(resolve => setTimeout(resolve, 200));
      const whileHidden = count;
      AtriumPower.host({occluded:false});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {whileHidden, afterReveal: count};
    } finally {
      AtriumPower.host({occluded:false});
      v.R.draw = render;
    }
  });
  assert.equal(hidden.whileHidden, 0, "an invalidated occluded viewer submits no draw");
  assert.ok(hidden.afterReveal > 0, "the visible viewer renders the pending redraw");
  await buttons["2d"].click(); assert.equal(await canvas.count(),0);
  assert.equal(await page.evaluate(() => JSON.stringify(AtriumNavHost.doc().items)),beforeItems,"view controls never edit the board");
  console.log("PASS browser 3D navigation: menu and keys in seven profiles, orbit/pan/zoom, selection, trusted touch, capture transition and focus; one draw per camera step and zero in 250 ms idle");
}

// Exercise the public Altium board through the same Format 2 projection and
// embedded folder worker used by a browser project after File Open.
function geometry(imported) {
  const scene = imported ? globalThis.importedScene : [...Atrium3D.viewers.values()][0].scene();
  const rows = [];
  for (const batch of scene.batches) {
    const bodies = batch.instances.filter(p => p.bodyRecord && !p.boundsOnly);
    if (!bodies.length) continue;
    const hash = [batch.positions, batch.normals, batch.indices].map(a =>
      AtriumSourceFile.sha256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))).join("/");
    for (const p of bodies) rows.push({key:[p.ref, p.side, hash].join("/"), matrix:Array.from(p.matrix)});
  }
  return rows.sort((a,b) => a.key.localeCompare(b.key));
}

function boardSubstrate() {
  const v = [...Atrium3D.viewers.values()][0];
  const points = v.scene().batches.find(b => b.kind === "board").positions;
  return AtriumSourceFile.sha256(new Uint8Array(points.buffer, points.byteOffset, points.byteLength));
}

function folderFixture() {
  require("../support/altium-folder.cjs");
  globalThis.CFB = require("../../app/vendor/cfb.min.js");
  for (const name of ["model", "parts", "board-shape", "altium-ids", "altium-rules", "pcb-import", "io"])
    require(require("../support/app-source-paths.cjs").appFile(name));
  const name = "PiDP11IOExpander.PcbDoc";
  const parsed = AtriumIO.read(name, Uint8Array.from(fs.readFileSync(path.join(__dirname, "../fixtures/altium/pidp11-io-expander", name))));
  const project = {...Atrium.project("PiDP Format 2"), documents:parsed.documents, library:parsed.library}, [board] = project.documents;
  const record = board.items.flatMap(i => i.bodies3d || []).find(b => b.type === "step");
  const shared = board.bodyModels.find(a => a.id === record.modelId);
  board.bodyModels.push({id:"alias", file:"Alias.step", assetId:shared.id});
  record.modelId = "alias";
  board.bodyModels.push({id:"unused", file:"Unused.step", stepText:fs.readFileSync(path.join(__dirname, "../fixtures/mcad/tray.step"), "utf8")});
  project.documents.push(Atrium.sheet("schematic", "Control sheet"));
  const background = Atrium.sheet("schematic", "Background sheet");
  const definition = {...AtriumParts.catalogue[0], id:"background-symbol", name:"Background symbol"};
  project.library.push(definition);
  project.documents.push(background);
  background.items.push(Atrium.instantiate(project, definition, [10, 10]));
  const native = AtriumFormat2Model.fromEditor(project);
  const files = native.files.map(({path, file}) => [path, AtriumFormat2.serialize(file)]);
  files.push(...native.models.map(({path, bytes}) => [path, bytes]));
  assert.equal(native.models.length, 9, "the fixture retains an unused payload and two aliases for one placed payload");
  return {project, manifest:native.manifestPath, files:files.map(([p, bytes]) => [p, Buffer.from(bytes).toString("base64")])};
}

async function checkFolder(page, {project, manifest, files}) {
  await page.addInitScript(() => localStorage.setItem("atrium.prefs", JSON.stringify({
    format:"atrium-prefs", version:1, values:{"general.startPage":"never", "general.efficiency":"always"}
  })));
  await page.goto(APP);
  assert.equal(await page.evaluate(async ({manifest, files}) => {
    const B = await AtriumLazy.need("AtriumBrowserProject");
    window.openModelFixture = (corrupt) => {
      const folder = B.create(manifest, new Map(files.map(([p, data]) => [p, Uint8Array.fromBase64(data)])));
      let gate;
      window.holdModelReads = () => { gate = new Promise(resolve => { window.releaseModelRead = resolve; }); };
      holdModelReads();
      window.modelReads = []; window.modelWrites = 0;
      const host = {...folder.host, async folderRead(request) {
        const models = request.paths.filter(p => p.startsWith("models/"));
        if (models.length) {
          modelReads.push(...models.map(path => ({path, drawn: Atrium3D.stats()?.draws > 0})));
          await gate;
        }
        const result = folder.host.folderRead(request);
        for (const file of result.files) if (file.path === corrupt) file.bytes = file.bytes.subarray(0, 12);
        return result;
      }, folderCommit() { modelWrites++; throw Error("Opening 3D must not write the project."); }};
      return AtriumNavHost.openFiles([{name:manifest, folderProject:{...folder, host}}]);
    };
    return openModelFixture();
  }, {manifest, files}), true);
  const state = () => page.evaluate(() => {
    const view = [...(globalThis.Atrium3D?.viewers.values() || [])][0];
    const h = AtriumNavHost;
    return {pending:view?.pending?.(), components:view?.scene?.()?.parts.filter(p => p.bodyRecord).length,
      reads:modelReads.slice(), writes:modelWrites, dirty:h.isDirty(), inline:h.doc().bodyModels.some(a => a.zlib || a.stepText)};
  });
  const initial = await state();
  assert.deepEqual(initial.reads, []);
  assert.equal(initial.inline, false);
  // Native folder Open keeps the Format 2 codec in its worker. The browser provider
  // also uses that worker, but imports the codec into the page for ZIP operations.
  await page.evaluate(() => { delete globalThis.AtriumFormat2Model; });

  const enter = async () => {
    await page.locator("#canvas").focus();
    await page.keyboard.press("3");
    await page.waitForFunction(() => globalThis.Atrium3D?.stats()?.draws > 0);
  };
  const leave = async () => {
    await page.keyboard.press("2");
    await page.waitForFunction(() => !Atrium3D.isOpen());
  };
  const rebuilt = () => page.waitForFunction(() => [...Atrium3D.viewers.values()][0].scene() !== previousScene);
  const settled = () => page.waitForFunction(() => {
    const v = [...Atrium3D.viewers.values()][0];
    return v.scene()?.hasLayers && !v.pending() && !v.renderPending();
  });
  await enter();
  const first = await state();
  assert.equal(first.components, 0);
  assert.match(first.pending || "", /Reading 8 3D models/, "the first board frame queues every referenced model");
  await page.waitForFunction(() => modelReads.length > 0);
  const select = kind => page.evaluate(kind => {
    const h = AtriumNavHost, ref = h.folderProject().documents().find(d => d.kind === kind);
    return h.selectDocument(ref.id);
  }, kind);
  await select("schematic");
  await page.waitForFunction(() => AtriumNavHost.doc().kind === "schematic" && !Atrium3D.isOpen());
  await page.evaluate(() => releaseModelRead());
  await select("pcb");
  await page.evaluate(() => AtriumUndoStore.sync(AtriumNavHost.project()));
  await enter();
  await page.waitForFunction(() => {
    const view = [...Atrium3D.viewers.values()][0];
    return !view?.pending?.() && view?.scene()?.parts.filter(p => p.bodyRecord && !p.boundsOnly).length === 23;
  });
  const loaded = await state(), actual = await page.evaluate(geometry);
  assert.equal(loaded.reads.length, 9, "one cancelled read, then eight distinct referenced payloads");
  assert.equal(new Set(loaded.reads.map(r => r.path)).size, 8, "the unused payload never reaches the 3D reader");
  assert.ok(loaded.reads.every(r => r.drawn));
  assert.equal(loaded.dirty, false); assert.equal(loaded.inline, false); assert.equal(loaded.writes, 0);
  // Compare both payload forms using the same runtime and tessellator.
  assert.equal(await page.evaluate(async source => {
    await AtriumLazy.need("AtriumResolvedGeometry");
    const direct = Atrium3D.meshFor(source, source.documents[0], 0, false);
    await Atrium3D.loadBodyMeshes(direct, AtriumSTEPImport);
    globalThis.importedScene = Atrium3D.buildScene(direct.meshed);
    return importedScene.parts.filter(p => p.bodyRecord && !p.boundsOnly).length;
  }, project), 23);
  const expected = await page.evaluate(geometry, true);
  assert.deepEqual(actual.map(r => r.key), expected.map(r => r.key), "every colour group has the imported geometry");
  actual.forEach((r, i) => r.matrix.forEach((n, j) => assert.ok(Math.abs(n - expected[i].matrix[j]) < 0.00004)));
  await leave();
  await page.evaluate(() => {
    // Run the same warm command and attach the draw counter before the browser
    // delivers the first ResizeObserver notification for the new viewer.
    AtriumNavHost.act("view-3d");
    const v = [...Atrium3D.viewers.values()][0], render = v.R.draw;
    const {width, height} = v.canvas, warm = window.warm3D = {observed:false, duplicateDraws:0};
    v.R.draw = frame => {
      if (frame.w === width && frame.h === height) warm.duplicateDraws++;
      return render(frame);
    };
    warm.restore = () => { v.R.draw = render; };
    const observer = new ResizeObserver(() => { observer.disconnect(); warm.observed = true; });
    observer.observe(v.stage);
  });
  assert.deepEqual(await state(), loaded, "warm 3D restores the complete board without new payload reads");
  assert.deepEqual(await page.evaluate(geometry), actual);
  await page.waitForFunction(() => warm3D.observed);
  await settled();
  assert.equal(await page.evaluate(() => {
    warm3D.restore();
    return warm3D.duplicateDraws;
  }), 0, "the first resize observation does not redraw a warm 3D view at the same size");

  const unrelated = await page.evaluate(async () => {
    const h = AtriumNavHost, project = h.project(), board = h.doc(), U = AtriumUndoStore;
    const v = [...Atrium3D.viewers.values()][0], render = v.R.draw;
    U.sync(project);
    const before = U.documentVersions(board), scene = v.scene();
    let draws = 0;
    v.R.draw = (...args) => { draws++; return render(...args); };
    try {
      const definition = {...AtriumParts.catalogue[0], id:AtriumUUID.next()};
      U.reconcile(project, () => project.library.push(definition), {library:true});
      const after = U.documentVersions(board);
      Atrium3D.refresh();
      const queued = v.renderPending();
      await new Promise(resolve => requestAnimationFrame(resolve));
      return {libraryChanged:after.library > before.library, sameBoard:after.floor === before.floor &&
        after.items === before.items && after.outer === before.outer && after.pours === before.pours,
        sameScene:v.scene() === scene, queued, draws};
    } finally { v.R.draw = render; }
  });
  assert.deepEqual(unrelated, {libraryChanged:true,sameBoard:true,sameScene:true,queued:false,draws:0},
    "3D IDLE UNRELATED LIBRARY: an unused definition leaves the loaded scene idle");

  const {height, width} = page.viewportSize();
  const previousHeight = await page.locator(".v3d-canvas").evaluate(canvas => canvas.height);
  await page.setViewportSize({width, height:height + 48});
  await page.waitForFunction(previous => {
    const {canvas, R} = [...Atrium3D.viewers.values()][0];
    return canvas.height > previous && R.gl.drawingBufferHeight === canvas.height;
  }, previousHeight);

  // A collapsed stage can return at the same CSS size, including on a
  // display with a different backing scale.
  const collapse = async () => {
    await page.evaluate(() => {
      const v = [...Atrium3D.viewers.values()][0];
      const resume = window.resume3D = {scene:v.scene(), frame:v.lastMatrices, display:v.stage.style.display, height:v.canvas.clientHeight};
      const observer = new ResizeObserver(([entry]) => {
        if (entry.contentRect.height) return;
        observer.disconnect();
        resume.collapsed = true;
      });
      observer.observe(v.stage);
      v.stage.style.display = "none";
    });
    await page.waitForFunction(() => resume3D.collapsed && ![...Atrium3D.viewers.values()][0].visible());
  };
  const resume = async dpr => {
    await page.evaluate(() => { [...Atrium3D.viewers.values()][0].stage.style.display = resume3D.display; });
    await page.waitForFunction(dpr => {
      const v = [...Atrium3D.viewers.values()][0], {canvas, R} = v;
      return devicePixelRatio === dpr && v.lastMatrices !== resume3D.frame && canvas.clientHeight === resume3D.height &&
        canvas.height === dpr * resume3D.height && R.gl.drawingBufferHeight === canvas.height;
    }, dpr);
    assert.equal(await page.evaluate(() => [...Atrium3D.viewers.values()][0].scene() === resume3D.scene), true,
      "returning to the same CSS viewport preserves the scene");
  };
  await collapse();
  await resume(1);
  await collapse();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {width, height:height + 48, deviceScaleFactor:2, mobile:false});
  await resume(2);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.detach();

  const setDrill = value => page.evaluate(value => {
    const h = AtriumNavHost, project = h.project(), U = AtriumUndoStore;
    const v = [...Atrium3D.viewers.values()][0];
    const used = new Set(h.doc().items.filter(i => i.kind === "part").map(i => i.def));
    const definition = project.library.find(d => used.has(d.id) && d.footprint?.pads.some(p => p.drill > 0));
    const pad = definition?.footprint.pads.find(p => p.drill > 0);
    const drill = pad.drill, version = U.definitionVersion(definition);
    window.previousScene = v.scene();
    U.reconcile(project, () => { pad.drill = value ?? drill * 0.94; }, {library:true});
    Atrium3D.refresh();
    return {drill, marked:U.definitionVersion(definition) > version};
  }, value);
  const original = await page.evaluate(boardSubstrate), {drill, marked} = await setDrill();
  assert.ok(marked, "a changed footprint advances its definition version");
  await rebuilt();
  assert.notEqual(await page.evaluate(boardSubstrate), original, "changing a footprint drill refreshes the board geometry");
  await setDrill(drill);
  await rebuilt();
  await settled();
  assert.equal(await page.evaluate(boardSubstrate), original, "restoring the drill also restores its board geometry");
  assert.equal((await state()).reads.length, loaded.reads.length, "unchanged STEP payloads remain resident after a footprint update");
  // Let an unrelated sheet publish its owner and library definition during a real
  // orbit. Hold any repeat asset reads so a transient loss of geometry is observable.
  const box = await page.locator(".v3d-canvas").boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 25, y - 12, {steps:4});
  const hydration = await page.evaluate(async () => {
    const h = AtriumNavHost, folder = h.folderProject(), background = folder.documents().find(d => d.name === "Background sheet");
    const before = AtriumUndoStore.documentVersions(h.doc()).library;
    const loaded = !!folder.loadedDocument(background.id);
    window.previousScene = [...Atrium3D.viewers.values()][0].scene();
    holdModelReads();
    await folder.ensureDocument(background.id, {purpose:"view"});
    Atrium3D.refresh();
    return {loaded, before, after:AtriumUndoStore.documentVersions(h.doc()).library};
  });
  await page.mouse.move(x + 75, y - 37, {steps:8});
  await page.mouse.up();
  await rebuilt();
  assert.ok(await page.evaluate(() => [...Atrium3D.viewers.values()][0].camera().pitch < 89));
  assert.equal(hydration.loaded, false, "the unrelated owner loads during the gesture");
  assert.ok(hydration.after > hydration.before, "the owner read changes the PCB's library version");
  assert.equal((await state()).components, 23, "hydrating another owner during orbit retains every placed STEP body");
  assert.deepEqual(await page.evaluate(geometry), actual);
  assert.equal((await state()).reads.length, loaded.reads.length, "existing verified geometry needs no repeat payload reads");

  // Replace one linked shape while moving its owner to the opposite side. The
  // other meshes stay resident and the changed digest has to finish its own read.
  const ref = await page.evaluate(() => {
    const h = AtriumNavHost, board = h.doc(), project = h.project();
    const part = board.items.find(i => i.layer === "Top" && i.bodies3d?.length === 1 && i.bodies3d[0].type === "step");
    window.previousScene = [...Atrium3D.viewers.values()][0].scene();
    AtriumUndoStore.reconcile(project, () => {
      part.bodies3d[0].modelId = "unused";
      part.layer = "Bottom";
    }, {doc:board});
    Atrium3D.refresh();
    return part.ref;
  });
  await rebuilt();
  assert.equal((await state()).components, 22, "only the body waiting for its new digest is absent");
  assert.deepEqual(await page.evaluate(geometry), actual.filter(r => !r.key.startsWith(ref + "/")));
  await page.evaluate(() => releaseModelRead());
  await page.waitForFunction(ref => [...Atrium3D.viewers.values()][0].scene().parts.some(p => p.ref === ref && p.side === "Bottom"), ref);
  const changed = (await page.evaluate(geometry)).filter(r => r.key.startsWith(ref + "/"));
  assert.ok(changed.every(r => r.key.startsWith(ref + "/Bottom/")));
  assert.notDeepEqual(changed.map(r => r.key.split("/").slice(2)), actual.filter(r => r.key.startsWith(ref + "/")).map(r => r.key.split("/").slice(2)));
  assert.equal((await state()).reads.length, loaded.reads.length + 1, "only the newly referenced payload is read");
  // A distinct session declares the same digests, but a corrupt file does not borrow
  // geometry from the previously visited project. Its healthy models still appear.
  await leave();
  const corrupt = loaded.reads[0].path;
  assert.equal(await page.evaluate(corrupt => openModelFixture(corrupt), corrupt), true);
  const omitted = await page.evaluate(corrupt => {
    const board = AtriumNavHost.doc();
    const aliases = new Set(board.bodyModels.filter(a => "models/" + a.model.sha256 + ".step.gz" === corrupt).map(a => a.id));
    return board.items.flatMap(i => i.bodies3d || []).filter(b => aliases.has(b.modelId)).length;
  }, corrupt);
  assert.ok(omitted > 0 && omitted < 23);
  await enter();
  await page.evaluate(() => releaseModelRead());
  await page.waitForFunction(expected => {
    const view = [...Atrium3D.viewers.values()][0];
    return !view.pending() && view.scene().parts.filter(p => p.bodyRecord).length >= expected;
  }, 23 - omitted);
  assert.equal((await state()).components, 23 - omitted);
  assert.match(await page.locator(".v3d-hud").textContent(), /STEP body .* was omitted.*gzip/);
  console.log("PASS Format 2 3D: deferred reads, warm reopen, idle library isolation, resize and resume, drill freshness, orbit residency and linked-body replacement");
}
