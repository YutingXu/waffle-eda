"use strict";

// Waffle's own title bar in the real Windows app (scripts/ci/windows-title-bar.ps1 starts the
// packaged Waffle.exe with a loopback WebView2 debugging port). The page is read over the DevTools
// protocol; the window is read and driven with real mouse and keyboard input by
// title-bar-native.ps1, in physical pixels. Each check is recorded in title-bar.json and the
// window is captured at each stage (PNG). The checks, in order:
//   no system caption: the page starts at the window's visible top edge;
//   under the launch Start Page (a modal dialog) the blank caption still moves the window;
//   the blank caption moves the window, a double press maximises and restores it;
//   Maximize, Restore and Minimize; the top edge resizes; a right click opens the window menu;
//   Close ends the app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {execFile} = require("node:child_process");
const execAsync = require("node:util").promisify(execFile);

const [port, output, processId, helper] = process.argv.slice(2);
const pid = Number(processId);
const address = "http://127.0.0.1:" + Number(port);
const pwsh = process.env.WAFFLE_TITLE_BAR_PWSH || "pwsh.exe";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
let ownTick = 0;

function receipt(name, value) {
  fs.writeFileSync(path.join(output, name + ".json"), JSON.stringify(value, null, 2) + "\n");
}
async function poll(check, error, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await wait(150);
  }
  throw Error(error);
}
async function requestJson(route) {
  const response = await fetch(address + route, {signal:AbortSignal.timeout(1500)});
  return response.ok ? response.json() : null;
}
async function connect(url) {
  const socket = new WebSocket(url), calls = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once:true});
    socket.addEventListener("error", () => reject(Error("WebView2 debugging socket failed")), {once:true});
  });
  socket.addEventListener("message", ({data}) => {
    const packet = JSON.parse(data), call = calls.get(packet.id);
    if (!call) return;
    calls.delete(packet.id);
    if (packet.error) call.reject(Error(JSON.stringify(packet.error))); else call.resolve(packet.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    calls.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
    setTimeout(() => { if (calls.delete(id)) reject(Error(method + " timed out")); }, 15000);
  });
  const evaluate = async expression => {
    const reply = await send("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true});
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };
  return {send, evaluate, close:() => socket.close()};
}

async function desktop(action, {steps, out, scale} = {}) {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper, "-WafflePid", String(pid), "-Action", action];
  if (scale) args.push("-Scale", String(scale));
  if (steps) args.push("-Steps", JSON.stringify(steps), "-OwnTick", String(ownTick));
  if (out) args.push("-Out", out);
  const {stdout} = await execAsync(pwsh, args, {encoding:"utf8", timeout:40000, windowsHide:true});
  const result = JSON.parse(stdout.replace(/^﻿/, ""));
  if (action === "input") {
    if (result.status !== "sent") throw Error("Input was not sent: " + result.reason);
    ownTick = result.tick;
  }
  return result;
}

function check(name, pass, detail) {
  checks.push({name, pass:!!pass, detail});
  console.log((pass ? "PASS " : "FAIL ") + name + (pass ? "" : " " + JSON.stringify(detail)));
}
const near = (a, b, slack = 3) => Math.abs(a - b) <= slack;

async function main() {
  const version = await poll(() => requestJson("/json/version"), "The packaged Waffle did not start WebView2");
  const target = await poll(async () => ((await requestJson("/json/list")) || [])
    .find(t => t.type === "page" && /^https:\/\/app\.waffle\.example\/index\.html/.test(t.url)), "No Waffle page target");
  const page = await connect(target.webSocketDebuggerUrl);
  try {
    await page.send("Runtime.enable");
    await poll(() => page.evaluate("!!globalThis.AtriumNavHost && document.querySelector('.window-controls') !== null"), "The page never drew the Windows caption");
    // The page's geometry in CSS pixels, read fresh after each change.
    const layout = () => page.evaluate(`(() => {
      const rect = el => { const r = el?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; };
      const root = document.documentElement, controls = document.querySelector(".window-controls");
      const button = name => rect(controls.querySelector('[data-window-command="' + name + '"]'));
      return {dpr:devicePixelRatio, caption:parseFloat(getComputedStyle(root).getPropertyValue("--window-caption-height")),
        mode:root.dataset.atriumNativeTitlebar, maximized:root.hasAttribute("data-window-maximized"),
        inactive:root.hasAttribute("data-window-inactive"), startPage:!!document.querySelector("dialog.sp-dialog[open]"),
        blank:rect(document.querySelector(".appbar-leading > [data-caption-drag]")), controls:rect(controls),
        minimize:button("minimize"), maximize:button("maximize"), close:button("close"),
        maximizeLabel:controls.querySelector('[data-window-command="maximize"]').getAttribute("aria-label")};
    })()`);
    const centre = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];
    const capture = name => desktop("capture", {out:path.join(output, name + ".png")}).catch(error => ({error:error.message}));
    receipt("webview2", {browser:version.Browser});

    let view = await layout(), state = await desktop("state");
    receipt("start", {view, state});
    check("the page draws the Windows caption", view.mode === "windows" && view.caption > 0, view);
    check("no system caption: the page starts at the window's visible top edge", near(state.client[1], state.frame[1], 1), {client:state.client, frame:state.frame});
    check("the window controls fill the top right of the page", view.controls && near(view.controls[0] + view.controls[2], (state.client[2] - state.client[0]) / view.dpr, 1) && view.controls[1] === 0, view.controls);
    await capture("1-start");

    // Under the Start Page (a modal dialog), as at every launch.
    if (view.startPage) {
      const before = (await desktop("state")).frame;
      const moved = (await desktop("input", {scale:view.dpr, steps:[{css:centre(view.blank)}, {down:"left"}, {wait:250}, {dx:90, dy:50}, {wait:150}, {up:"left"}, {wait:300}]})).state.frame;
      check("under the Start Page the blank caption moves the window", near(moved[0] - before[0], 90, 4) && near(moved[1] - before[1], 50, 4), {before, moved});
      check("the Start Page stays open", (await layout()).startPage, null);
      await page.evaluate("for (const d of document.querySelectorAll('dialog.sp-dialog[open]')) d.close()");
    } else check("the Start Page was open at launch", false, view);
    await wait(300);

    // Move, then maximise and restore with a double press on the blank caption.
    view = await layout();
    let before = (await desktop("state")).frame;
    let after = (await desktop("input", {scale:view.dpr, steps:[{css:centre(view.blank)}, {down:"left"}, {wait:250}, {dx:-120, dy:-40}, {wait:150}, {up:"left"}, {wait:300}]})).state.frame;
    check("the blank caption moves the window", near(after[0] - before[0], -120, 4) && near(after[1] - before[1], -40, 4), {before, after});
    view = await layout();
    const press = point => [{css:point}, {down:"left"}, {up:"left"}];
    let result = (await desktop("input", {scale:view.dpr, steps:[...press(centre(view.blank)), {wait:60}, {down:"left"}, {up:"left"}, {wait:700}]})).state;
    view = await layout();
    check("a double press on the blank caption maximises the window", result.zoomed && view.maximized && view.maximizeLabel === "Restore", {zoomed:result.zoomed, view});
    check("maximised, the whole page is on the screen", result.client[1] >= result.monitor[1] && result.client[3] <= result.work[3] + 1 && result.client[0] >= result.monitor[0], {client:result.client, monitor:result.monitor, work:result.work});
    await capture("2-maximized");
    result = (await desktop("input", {scale:view.dpr, steps:[...press(centre(view.blank)), {wait:60}, {down:"left"}, {up:"left"}, {wait:700}]})).state;
    view = await layout();
    check("a second double press restores it", !result.zoomed && !view.maximized && view.maximizeLabel === "Maximize", {zoomed:result.zoomed});

    // The caption buttons.
    result = (await desktop("input", {scale:view.dpr, steps:[...press(centre(view.maximize)), {wait:700}]})).state;
    view = await layout();
    check("Maximize maximises the window", result.zoomed && view.maximized, {zoomed:result.zoomed});
    result = (await desktop("input", {scale:view.dpr, steps:[...press(centre(view.maximize)), {wait:700}]})).state;
    view = await layout();
    check("Restore restores it", !result.zoomed && !view.maximized, {zoomed:result.zoomed});

    // The top edge resizes the window; its bottom stays.
    before = (await desktop("state")).frame;
    after = (await desktop("input", {scale:view.dpr, steps:[{css:[view.blank[0] + view.blank[2] / 2, 1]}, {wait:100}, {down:"left"}, {wait:250}, {dx:0, dy:-60}, {wait:150}, {up:"left"}, {wait:300}]})).state.frame;
    check("the top edge resizes the window", near(after[1] - before[1], -60, 4) && near(after[3], before[3], 2), {before, after});

    // The window menu, then Escape.
    view = await layout();
    result = (await desktop("input", {scale:view.dpr, steps:[{css:centre(view.blank)}, {down:"right"}, {up:"right"}, {wait:500}]})).state;
    check("a right click on the blank caption opens the window menu", result.menuOpen, null);
    result = (await desktop("input", {scale:view.dpr, steps:[{key:"escape"}, {wait:300}]})).state;
    check("Escape closes the window menu", !result.menuOpen, null);

    // Hover feedback on Close, captured for review.
    await desktop("input", {scale:view.dpr, steps:[{css:centre(view.close)}, {wait:400}]});
    const hover = await page.evaluate(`(() => { const b = document.querySelector('.window-controls [data-window-command="close"]');
      return {hover:b.matches(":hover"), fill:getComputedStyle(b).backgroundColor}; })()`);
    check("Close shows its hover fill", hover.hover && hover.fill !== "rgba(0, 0, 0, 0)", hover);
    await capture("3-close-hover");
    await desktop("input", {scale:view.dpr, steps:[{css:centre(view.blank)}, {wait:200}]});

    // Minimize, then restore from the host side.
    result = (await desktop("input", {scale:view.dpr, steps:[...press(centre(view.minimize)), {wait:700}]})).state;
    check("Minimize minimises the window", result.iconic, null);
    result = await desktop("restore");
    check("the window comes back", !result.iconic, null);
    await wait(500);
    await capture("4-restored");

    // Close: nothing was edited, so the app ends without asking.
    view = await layout();
    await desktop("input", {scale:view.dpr, steps:[...press(centre(view.close))]});
    const ended = await poll(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, "", 10000).catch(() => false);
    check("Close ends the app", ended, null);
  } finally {
    page.close();
    receipt("title-bar", {checks, passed:checks.filter(c => c.pass).length, failed:checks.filter(c => !c.pass).length});
  }
  if (checks.some(c => !c.pass)) process.exitCode = 1;
}
main().catch(error => {
  receipt("error", {message:error.message, stack:error.stack, checks});
  console.error(error);
  process.exitCode = 1;
});
