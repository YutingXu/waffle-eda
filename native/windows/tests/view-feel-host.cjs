"use strict";

// Run the native WebView2 timing probe through a single loopback app profile.
// The PowerShell launcher checks the package and board hashes before starting Waffle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {execFile, execFileSync} = require("node:child_process");
const execAsync = require("node:util").promisify(execFile);
const {EventEmitter} = require("node:events");
const {pipeline} = require("node:stream/promises");
const {createGunzip} = require("node:zlib");
const {qualifyViewFeel} = require("./view-feel.cjs");

const [port, output, processId, launcher, expectedAdapter, fixture, minimumItems, repeats, withTrace] = process.argv.slice(2);
const pid = Number(processId);
const address = "http://127.0.0.1:" + Number(port);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function writeReceipt(name, value) {
  assert.match(name, /^[a-z\d][a-z\d._-]+$/i);
  const file = path.join(output, name.endsWith(".json") ? name : name + ".json");
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
async function requestJson(route) {
  try {
    const response = await fetch(address + route, {signal:AbortSignal.timeout(1500)});
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
async function poll(check, error, milliseconds = 25000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await wait(150);
  }
  throw Error(error);
}

async function connect(url) {
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\//);
  const socket = new WebSocket(url);
  const events = new EventEmitter();
  const calls = new Map();
  const errors = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("WebView2 diagnostic socket did not open")), 7000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, {once:true});
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("WebView2 diagnostic socket failed")); }, {once:true});
  });
  socket.addEventListener("message", ({data}) => {
    const packet = JSON.parse(data);
    if (packet.method) {
      if (packet.method === "Runtime.exceptionThrown") {
        const details = packet.params.exceptionDetails;
        errors.push(details.exception?.description || details.text);
      }
      events.emit(packet.method, packet.params);
      return;
    }
    const request = calls.get(packet.id);
    if (!request) return;
    calls.delete(packet.id);
    clearTimeout(request.timer);
    if (packet.error) request.reject(Error(request.method + " " + JSON.stringify(packet.error)));
    else request.resolve(packet.result);
  });
  socket.addEventListener("close", () => {
    for (const request of calls.values()) {
      clearTimeout(request.timer);
      request.reject(Error("WebView2 disconnected while handling " + request.method));
    }
    calls.clear();
  });

  function send(method, params = {}, deadline = 15000) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(Error(method + " timed out"));
      }, deadline);
      calls.set(id, {method, timer, resolve, reject});
      socket.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression, deadline) {
    const reply = await send("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true}, deadline);
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }
  return {send,evaluate,errors,events,close:() => socket.close()};
}

function checkWindow(activate = false) {
  const executable = process.env.WAFFLE_TIMING_PWSH || "pwsh.exe";
  const argv = ["-NoLogo","-NoProfile","-NonInteractive","-File",launcher,"-ProbePid",String(pid)];
  if (activate) argv.push("-ActivateProbeWindow");
  const raw = execFileSync(executable, argv,{encoding:"utf8",timeout:12000,windowsHide:true});
  return JSON.parse(raw.replace(/^\uFEFF/,""));
}

async function sendNativeWheel({point,dpr,steps,intervalMs}) {
  const script = path.join(__dirname, "view-feel-native-wheel.ps1");
  const executable = process.env.WAFFLE_TIMING_PWSH || "pwsh.exe";
  const {stdout} = await execAsync(executable, ["-NoLogo","-NoProfile","-NonInteractive","-File",script,
    "-WafflePid",String(pid),"-CssX",String(point[0]),"-CssY",String(point[1]),"-Scale",String(dpr),
    "-Steps",JSON.stringify(steps),"-IntervalMs",String(intervalMs)],{encoding:"utf8",timeout:18000,windowsHide:true});
  return JSON.parse(stdout.replace(/^\uFEFF/,""));
}

async function startTrace(browser) {
  const includedCategories = ["benchmark","cc","viz","gpu","blink.user_timing",
    "disabled-by-default-display.framedisplayed","disabled-by-default-devtools.timeline.frame"];
  await browser.send("Tracing.start", {
    traceConfig:{recordMode:"recordAsMuchAsPossible",includedCategories,excludedCategories:["*"]},
    transferMode:"ReturnAsStream", streamFormat:"json", streamCompression:"gzip",
  });
  return async () => {
    let timer, tracingComplete;
    const complete = new Promise((resolve, reject) => {
      tracingComplete = resolve;
      browser.events.once("Tracing.tracingComplete", tracingComplete);
      timer = setTimeout(() => reject(Error("Chromium did not close its compositor trace")), 15000);
    });
    let info;
    try {
      [, info] = await Promise.all([browser.send("Tracing.end"), complete]);
    } finally {
      clearTimeout(timer);
      browser.events.off("Tracing.tracingComplete", tracingComplete);
    }
    assert.ok(info.stream, "Chromium did not return the trace stream");
    const tracePath = path.join(output, "chromium-trace.json.gz");
    const fd = fs.openSync(tracePath,"w");
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await browser.send("IO.read",{handle:info.stream,size:512*1024});
        const data = Buffer.from(chunk.data,chunk.base64Encoded ? "base64" : "utf8");
        fs.writeSync(fd,data);
        bytes += data.length;
        if (chunk.eof) break;
      }
    } finally {
      fs.closeSync(fd);
      await browser.send("IO.close",{handle:info.stream});
    }
    const receipt = {bytes, dataLoss:!!info.dataLossOccurred, categories:includedCategories,
      description:"Raw WebView2 Chromium trace with browser compositor feedback. Not ETW or panel scanout."};
    try {
      assert.ok(bytes > 0, "Chromium returned an empty trace stream");
      let beginning = "";
      await pipeline(fs.createReadStream(tracePath), createGunzip(), async function inspectTrace(events) {
        for await (const chunk of events) {
          if (beginning.length < 4096) beginning += chunk.toString("utf8", 0, 4096 - beginning.length);
        }
      });
      assert.match(beginning, /^\s*\{\s*"traceEvents"\s*:\s*\[\s*\{/, "Chromium returned a trace without events");
      assert.ok(!receipt.dataLoss, "Chromium reported trace data loss");
    } catch (error) {
      return {...receipt,error:error.message};
    }
    return receipt;
  };
}

async function startProfile(client) {
  await client.send("Profiler.enable");
  await client.send("Profiler.setSamplingInterval",{interval:1000});
  await client.send("Profiler.start");
  return async () => {
    try {
      const {profile} = await client.send("Profiler.stop",{},30000);
      assert.ok(profile?.samples?.length, "The renderer did not return JavaScript profile samples");
      writeReceipt("renderer-cpu-profile",profile);
    } finally {
      await client.send("Profiler.disable");
    }
  };
}

async function main() {
  const version = await poll(() => requestJson("/json/version"),"The unpacked Waffle did not start WebView2");
  assert.match(version.Browser || "", /^Edg\//i);
  const browser = await connect(version.webSocketDebuggerUrl);
  try {
    const {gpu} = await browser.send("SystemInfo.getInfo");
    const {processInfo} = await browser.send("SystemInfo.getProcessInfo").catch(() => ({processInfo:[]}));
    writeReceipt("webview2",{browser:version.Browser,protocolVersion:version["Protocol-Version"],gpu,processInfo});
    const page = await poll(async () => {
      const targets = (await requestJson("/json/list")) || [];
      return targets.find(target => target.type === "page" && /^https:\/\/app\.waffle\.example\/index\.html(?:$|[?#])/.test(target.url));
    }, "No native app editor target was found");
    const client = await connect(page.webSocketDebuggerUrl);
    try {
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      let triedActivation = false;
      const initial = await poll(() => {
        let state = checkWindow();
        if (!triedActivation && state.visible && !state.foreground && state.activeConsole) {
          writeReceipt("native-window-before-activation",state);
          state = checkWindow(true);
          triedActivation = true;
        }
        writeReceipt("native-window-last-start-observation",state);
        return state.visible && state.foreground && state.activeConsole && state.refreshHz > 1 ? state : null;
      }, "The real Waffle window was not visible on the unlocked foreground console");
      writeReceipt("native-window-start",initial);
      const finishTrace = withTrace === "1" ? await startTrace(browser).catch(error => {
        writeReceipt("trace-receipt",{error:error.message}); return null;
      }) : null;
      const finishProfile = withTrace === "1" ? await startProfile(client).catch(error => {
        writeReceipt("cpu-profile-error",{error:error.message});
        return null;
      }) : null;
      let result;
      let traceFailed = withTrace === "1" && !finishTrace;
      try {
        result = await qualifyViewFeel(client,{
          fixture, expectedItems:Number(minimumItems), expectedPid:pid, refreshHz:initial.refreshHz,
          expectedAdapter, checkWindow, expectedDisplay:JSON.parse(process.env.WAFFLE_TIMING_EXPECTED_DISPLAY || "[]").length
            ? JSON.parse(process.env.WAFFLE_TIMING_EXPECTED_DISPLAY) : undefined,
          repetitions:Number(repeats), diagnostic:withTrace === "1", sendNativeWheel,
          tag:path.basename(output), writeReceipt:(name,receipt) => typeof name === "string"
            ? writeReceipt(name,receipt) : writeReceipt("view-feel-result",name),
        });
        if (result !== undefined) writeReceipt("view-feel-result",result);
      } finally {
        if (finishProfile) await finishProfile().catch(error => writeReceipt("cpu-profile-error",{error:error.message}));
        if (finishTrace) {
          const traceReceipt = await finishTrace().catch(error => ({error:error.message}));
          writeReceipt("trace-receipt",traceReceipt);
          traceFailed = !!traceReceipt.error;
        }
        writeReceipt("native-window-end",checkWindow());
      }
      if (client.errors.length) writeReceipt("render-exceptions",client.errors);
      if (traceFailed || (result?.status !== "pass" && result?.status !== "diagnostic")) process.exitCode = 1;
    } finally { client.close(); }
  } finally { browser.close(); }
}
main().catch(error => {
  writeReceipt("measurement-error",{message:error.message, stack:error.stack});
  console.error(error);
  process.exitCode = 1;
});
