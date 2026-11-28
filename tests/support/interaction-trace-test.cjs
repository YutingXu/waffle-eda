"use strict";

const assert = require("node:assert/strict");
const {summarize} = require("../../scripts/ci/interaction_trace.cjs");

const main = {pid:7, tid:10};
const mark = (name, ts, callTime, detail) => ({...main, cat:"blink.user_timing", name:"waffle." + name, ts, ph:"I", args:{data:{callTime, detail}}});
const event = (name, type, ts, dur, tid = main.tid) => ({...main, tid, name, ph:"X", ts, dur, args:{data:{type}}});
const frame = (ts, sequence_number, source_id = 1) => ({...main, name:"AnimationFrame::Presentation", ts, args:{begin_frame_id:{source_id, sequence_number}}});
function latency(ph, ts, type, display, pid = main.pid) {
  return {pid, tid:20, name:"EventLatency", ph, ts, id2:{local:"0x1"},
    args:{event_latency:{event_type:type, display_trace_id:display}}};
}

const events = [
  mark("start.filter", 1000), mark("end.filter", 100000), mark("start.filter", 110000), mark("end.filter", 150000),
  mark("start.hover", 160000), mark("end.hover", 170000),
  mark("input.search.keydown", 2000, 3500, "1.6"), mark("input.search.input", 2800, 2673, "0"), mark("result.count", 2000, 82000, "80"),
  mark("result.count", 99000, 102000, "3"), // A late mutation cannot finish this window.
  frame(10000, 1), frame(13000, 1), frame(17000, 0, 0), frame(27000, 2), mark("actionsEnd.filter", 70000), frame(86000, 3),
  frame(115000, 4), frame(131000, 5),
  {...main, name:"EventTiming", ph:"b", ts:3000, args:{data:{type:"keydown", timeStamp:3, processingStart:3.5, duration:21}}},
  event("EventDispatch", "keydown", 3000, 2600), event("EventDispatch", "keydown", 112000, 5200),
  event("EventDispatch", "keydown", 113000, 79000, 12), event("EventDispatch", "keydown", 104000, 1000),
  event("ThreadControllerImpl::RunTask", null, 4000, 55000),
  latency("b", 2000, "KEY_PRESSED", 0), latency("e", 11000, null, null, 4), latency("e", 15000),
  latency("b", 18000, "KEY_PRESSED"), latency("e", 24000), // No display feedback.
  latency("b", 98000, "KEY_PRESSED", 3), latency("e", 108000),
  latency("b", 116000, "KEY_PRESSED", 4), latency("e", 146000),
  latency("b", 162000, "MOUSE_MOVED"), latency("e", 166000),
  {...main, name:"Profile", id:"0x7", ts:500, args:{data:{startTime:500}}},
  {...main, tid:21, name:"ProfileChunk", id:"0x7", ts:172000, args:{data:{
    cpuProfile:{nodes:[
      {id:1, callFrame:{url:"http://127.0.0.1:9999/editor.js", lineNumber:3, functionName:"filter"}},
      {id:2, parent:1, callFrame:{url:"", functionName:"(native)"}}
    ], samples:[2,2,2]}, timeDeltas:[2000,99900,10000]
  }}}
];

// Chrome streams events from different threads. Some IDs are recycled.
const result = summarize(events.reverse());
assert.equal(result.filter.windows, 2);
assert.deepEqual(result.filter.dispatchMs.keydown, {n:2, p50:2.6, p95:5.2, p99:5.2, max:5.2});
assert.equal(result.filter.captureDelayMs["search.keydown"].p95, 1.6);
assert.deepEqual(result.filter.captureDelayMs["search.input"], {n:1, p50:0, p95:0, p99:0, max:0});
assert.equal(result.filter.inputDelayMs.keydown.p95, .5);
assert.equal(result.filter.eventDurationMs.keydown.p95, 21);
assert.deepEqual(result.filter.presentedIntervalMs, {n:2, p50:16, p95:17, p99:17, max:17});
assert.equal(result.hover.presentedIntervalMs, null);
assert.deepEqual(result.filter.resultMs.count, {n:1, p50:80, p95:80, p99:80, max:80});
assert.equal(result.filter.latencyRecords.KEY_PRESSED, 4);
assert.deepEqual(result.filter.compositorMs.KEY_PRESSED, {n:2, p50:13, p95:30, p99:30, max:30});
assert.equal(result.filter.laterFeedback.KEY_PRESSED, 1);
assert.equal(result.hover.latencyRecords.MOUSE_MOVED, 1);
assert.equal(result.hover.compositorMs.MOUSE_MOVED, undefined);
assert.deepEqual(result.filter.samples, [{site:"/editor.js:4 filter", n:2}]);
assert.equal(result.filter.longTasks, 1);
assert.throws(() => summarize([mark("start.filter", 1000)]), /missing interaction markers/);
console.log("PASS interaction windows, trusted input, result updates, compositor feedback and sampled stacks");
