"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {Readable} = require("node:stream");
const {pipeline} = require("node:stream/promises");
const {createGunzip} = require("node:zlib");

// Run only in the traced browser. Event Timing omits continuous input. Both
// ends use the page's performance clock, including its timestamp precision.
function observeInput() {
  if (window !== window.top) return;
  function capture(event) {
    if (!event.isTrusted || !window.waffleTraceActive || event.timeStamp <= 0) return;
    const delay = Math.max(0, performance.now() - event.timeStamp);
    const el = event.target;
    let surface = "shell";
    if (el?.tagName === "CANVAS") surface = "canvas";
    else if (el?.type === "search") surface = "search";
    else if (el?.closest?.("input, textarea, select, [contenteditable=true]")) surface = "field";
    else if (el?.closest?.("table, [role=grid]")) surface = "table";
    else if (el?.closest?.("dialog")) surface = "dialog";
    const pointer = event.type.startsWith("pointer") && ["mouse", "pen", "touch"].includes(event.pointerType) ? event.pointerType + "." : "";
    const name = "waffle.input." + surface + "." + pointer + event.type;
    performance.mark(name, {startTime:event.timeStamp, detail:delay});
    performance.clearMarks(name);
  }
  const types = "keydown keypress keyup beforeinput input change compositionstart compositionupdate compositionend " +
    "pointerdown pointermove pointerup pointercancel pointerover pointerout gotpointercapture lostpointercapture " +
    "mousedown mousemove mouseup mouseover mouseout click dblclick auxclick contextmenu wheel scroll scrollend " +
    "touchstart touchmove touchend touchcancel gesturestart gesturechange gestureend dragstart dragenter dragover dragleave drop dragend " +
    "focusin focusout select selectionchange submit reset copy cut paste";
  for (const type of types.split(" ")) window.addEventListener(type, capture, {capture:true, passive:true});
}

// Measure through the actual result mutation. A debounced render belongs to
// the last input that reached the field. Keep these marks in the raw trace too.
async function watchResult(page, options) {
  const observer = await page.evaluateHandle(({input, output, name, key, attribute, requireChange}) => {
    const result = document.querySelector(output);
    if (!result || !document.querySelector(input)) throw Error("Missing control or result for " + name);
    const value = () => attribute ? result.getAttribute(attribute) : result.textContent;
    let stamp, prior, phase;
    const start = e => {
      if (!e.isTrusted || !window.waffleTraceActive || !e.target.matches?.(input) || key && e.key !== key) return;
      stamp = e.timeStamp; phase = window.waffleTraceActive; prior = requireChange && value();
    };
    const changes = new MutationObserver(() => {
      if (stamp == null || phase !== window.waffleTraceActive || requireChange && prior === value()) return;
      const mark = "waffle.result." + name;
      performance.mark(mark, {startTime:stamp, detail:Math.max(0, performance.now() - stamp)});
      performance.clearMarks(mark);
      stamp = null;
    });
    changes.observe(result, attribute ? {attributeFilter:[attribute]} : {childList:true, characterData:true, subtree:true});
    document.addEventListener("keydown", start, true);
    return () => { changes.disconnect(); document.removeEventListener("keydown", start, true); };
  }, options);
  return async () => {
    try { await observer.evaluate(stop => stop()); } finally { await observer.dispose(); }
  };
}

// Keep the original Chromium stream. In particular, some compositor IDs exceed
// JavaScript's safe integer range and would change if we re-encoded the events.
async function startTrace(cdp) {
  await cdp.send("Tracing.start", {transferMode:"ReturnAsStream", streamFormat:"json", streamCompression:"gzip",
    traceConfig:{recordMode:"recordAsMuchAsPossible", excludedCategories:["*"], includedCategories:[
      "devtools.timeline", "blink.user_timing", "benchmark", "input", "latencyInfo", "toplevel", "disabled-by-default-v8.cpu_profiler"
    ]}});
  return async file => {
    const done = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    const {stream, dataLossOccurred} = await done;
    async function* read() {
      for (;;) {
        const block = await cdp.send("IO.read", {handle:stream, size:512 * 1024});
        yield Buffer.from(block.data, block.base64Encoded ? "base64" : "utf8");
        if (block.eof) break;
      }
    }
    try { await pipeline(Readable.from(read()), fs.createWriteStream(file, {flags:"wx"})); }
    finally { await cdp.send("IO.close", {handle:stream}); }
    assert.ok(!dataLossOccurred, "Chromium reported lost trace events in " + file);
  };
}

function stats(samples) {
  const sorted = samples.sort((a, b) => a - b);
  const quantile = q => +sorted[Math.ceil(q * sorted.length) - 1].toFixed(2);
  return {n:sorted.length, p50:quantile(.5), p95:quantile(.95), p99:quantile(.99), max:quantile(1)};
}

function summarize(events) {
  const marks = events.filter(e => e.cat === "blink.user_timing" && /^waffle\.(start|end)\./.test(e.name)).sort((a,b) => a.ts - b.ts);
  assert.ok(marks.length && marks.length % 2 === 0, "missing interaction markers");
  const phases = [], results = Object.create(null);
  const group = () => Object.create(null);
  for (let i = 0; i < marks.length; i += 2) {
    const [start, end] = [marks[i], marks[i + 1]], name = start.name.slice("waffle.start.".length);
    assert.ok(start.name === "waffle.start." + name && end.name === "waffle.end." + name &&
      start.pid === end.pid && start.tid === end.tid, "unpaired interaction markers for " + name);
    phases.push({start:start.ts, end:end.ts, inputEnd:end.ts, pid:start.pid, tid:start.tid, name, frames:[]});
    results[name] ??= {windows:0, dispatchMs:group(), captureDelayMs:group(), inputDelayMs:group(), eventDurationMs:group(), resultMs:group(),
      compositorMs:group(), presentedIntervalMs:[], latencyRecords:group(),
      laterFeedback:group(), workMs:group(), callbacks:new Map(), samples:new Map(), longTasks:0};
    results[name].windows++;
  }
  function phaseAt(event) {
    let lo = 0, hi = phases.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (phases[mid].start <= event.ts) lo = mid + 1; else hi = mid;
    }
    const phase = phases[lo - 1];
    if (phase && event.ts < phase.end && event.pid === phase.pid) return phase;
  }
  function add(group, name, ms) {
    if (Number.isFinite(ms) && ms >= 0) (group[name] ??= []).push(ms);
  }
  const work = new Set(["Layout", "UpdateLayoutTree", "Paint", "FireAnimationFrame"]), latency = [], profiles = [];
  for (const e of events) {
    if (e.name === "EventLatency") { latency.push(e); continue; }
    if (e.name === "Profile" || e.name === "ProfileChunk") { profiles.push(e); continue; }
    const phase = phaseAt(e);
    if (!phase || e.tid !== phase.tid) continue;
    const row = results[phase.name], data = e.args?.data;
    if (e.name === "waffle.actionsEnd." + phase.name) phase.inputEnd = e.ts;
    if (e.name === "AnimationFrame::Presentation" && e.args?.begin_frame_id?.source_id && e.args.begin_frame_id.sequence_number) {
      phase.frames.push(e);
    }
    if (e.cat === "blink.user_timing" && e.name.startsWith("waffle.input.")) {
      add(row.captureDelayMs, e.name.slice("waffle.input.".length), Number(data?.detail ?? NaN));
    }
    if (e.cat === "blink.user_timing" && e.name.startsWith("waffle.result.") && data?.callTime <= phase.end) {
      add(row.resultMs, e.name.slice("waffle.result.".length), Number(data.detail ?? NaN));
    }
    if (e.ph === "b" && e.name === "EventTiming" && data?.type) {
      add(row.inputDelayMs, data.type, data.processingStart - data.timeStamp);
      add(row.eventDurationMs, data.type, data.duration);
    }
    if (e.ph !== "X") continue;
    const ms = e.dur / 1000;
    if (e.name === "EventDispatch" && data?.type && !data.type.startsWith("__playwright")) add(row.dispatchMs, data.type, ms);
    if (work.has(e.name)) add(row.workMs, e.name, ms);
    if ((e.name === "ThreadControllerImpl::RunTask" || e.name === "RunTask") && ms > 50) row.longTasks++;
    if (e.name === "FunctionCall" && data?.url?.startsWith("http://127.0.0.1:")) {
      const site = new URL(data.url).pathname + ":" + data.lineNumber + " " + (data.functionName || "(anonymous)");
      row.callbacks.set(site, (row.callbacks.get(site) || 0) + ms);
    }
  }
  // Renderer presentation feedback with a real begin-frame ID. Omit the
  // post-action settling period and never bridge two input windows.
  for (const phase of phases) {
    const latest = new Map(), intervals = results[phase.name].presentedIntervalMs;
    for (const frame of phase.frames.sort((a,b) => a.ts - b.ts)) {
      if (frame.ts > phase.inputEnd) break;
      const id = frame.args.begin_frame_id, prior = latest.get(id.source_id);
      if (prior && id.sequence_number <= prior.sequence) continue;
      if (prior) intervals.push((frame.ts - prior.ts) / 1000);
      latest.set(id.source_id, {ts:frame.ts, sequence:id.sequence_number});
    }
  }
  // EventLatency lives on the compositor thread. Chromium reuses process-local
  // async IDs. Pair chronologically, including ends after the input's window.
  const pending = new Map();
  for (const e of latency.sort((a,b) => a.ts - b.ts)) {
    const id = e.id2?.local;
    if (id == null) continue;
    const key = e.pid + "/" + id;
    if (e.ph === "b") {
      const data = e.args?.event_latency, phase = phaseAt(e);
      if (phase && data?.event_type) {
        const records = results[phase.name].latencyRecords;
        records[data.event_type] = (records[data.event_type] || 0) + 1;
      }
      if (phase && data?.display_trace_id != null) pending.set(key, {phase, type:data.event_type, ts:e.ts});
      else pending.delete(key);
    } else if (e.ph === "e") {
      const begin = pending.get(key);
      if (begin) {
        const row = results[begin.phase.name];
        if (e.ts <= begin.phase.end) add(row.compositorMs, begin.type, (e.ts - begin.ts) / 1000);
        else row.laterFeedback[begin.type] = (row.laterFeedback[begin.type] || 0) + 1;
      }
      pending.delete(key);
    }
  }
  // ProfileChunk can arrive on a profiler thread. The Profile header identifies
  // the sampled thread; sample timestamps accumulate from its startTime.
  const streams = new Map();
  for (const e of profiles.sort((a,b) => a.ts - b.ts)) {
    const key = e.pid + "/" + e.id, d = e.args.data;
    if (e.name === "Profile") {
      streams.set(key, {tid:e.tid, ts:d.startTime, nodes:new Map()}); continue;
    }
    const stream = streams.get(key);
    if (!stream) continue;
    for (const node of d.cpuProfile?.nodes || []) stream.nodes.set(node.id, node);
    for (const [i, id] of (d.cpuProfile?.samples || []).entries()) {
      stream.ts += d.timeDeltas[i];
      const phase = phaseAt({pid:e.pid, ts:stream.ts});
      if (!phase || stream.tid !== phase.tid) continue;
      let node = stream.nodes.get(id);
      while (node && !node.callFrame.url?.startsWith("http://127.0.0.1:")) node = stream.nodes.get(node.parent);
      if (!node) continue;
      const frame = node.callFrame, site = new URL(frame.url).pathname + ":" + (frame.lineNumber + 1) + " " + (frame.functionName || "(anonymous)");
      const samples = results[phase.name].samples;
      samples.set(site, (samples.get(site) || 0) + 1);
    }
  }
  for (const row of Object.values(results)) {
    for (const group of [row.dispatchMs, row.captureDelayMs, row.inputDelayMs, row.eventDurationMs, row.resultMs, row.compositorMs, row.workMs]) {
      for (const key of Object.keys(group)) group[key] = stats(group[key]);
    }
    row.presentedIntervalMs = row.presentedIntervalMs.length ? stats(row.presentedIntervalMs) : null;
    row.callbacks = [...row.callbacks].sort((a,b) => b[1] - a[1]).slice(0, 5)
      .map(([site, total]) => ({site, inclusiveMs:+total.toFixed(2)}));
    row.samples = [...row.samples].sort((a,b) => b[1] - a[1]).slice(0, 5).map(([site, n]) => ({site, n}));
  }
  return results;
}

// Chromium's JSON stream puts one compact event on each line. Discard browser
// bookkeeping as we inflate it, so long manual captures can exceed Node's
// single-string limit. Drain the metadata tail to verify the gzip checksum.
async function summarizeFile(file) {
  const {createInterface} = require("node:readline");
  const names = new Set(["EventDispatch", "EventTiming", "EventLatency", "FunctionCall", "Layout", "UpdateLayoutTree", "Paint",
    "FireAnimationFrame", "AnimationFrame::Presentation", "ProfileChunk", "Profile"]);
  const events = [];
  await pipeline(fs.createReadStream(file), createGunzip(), async source => {
    let started = false, ended = false;
    for await (let line of createInterface({input:source, crlfDelay:Infinity})) {
      if (ended) continue;
      if (!started) {
        assert.match(line, /^\s*\{\s*"traceEvents"\s*:\s*\[\s*$/);
        started = true; continue;
      }
      // The array terminator can follow the last event on the same line.
      const trailer = /\]\s*(?:,\s*"metadata"\s*:|\})\s*$/.exec(line);
      if (trailer) { ended = true; line = line.slice(0, trailer.index); }
      line = line.trim().replace(/,$/, "");
      if (!line) continue;
      const e = JSON.parse(line);
      if (names.has(e.name) || e.name.startsWith("waffle.") ||
          (e.name === "ThreadControllerImpl::RunTask" || e.name === "RunTask") && e.dur > 50000) events.push(e);
    }
    assert.ok(ended, "incomplete Chromium trace event array");
  });
  return summarize(events);
}

module.exports = {observeInput, watchResult, startTrace, summarizeFile, summarize};
