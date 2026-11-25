"use strict";

try {
  const state = {samples: [], dropped: 0};
  const target = WI.mainTarget;
  if (!target?.hasDomain("Memory") || !target.connection) throw Error("No Web Inspector Memory target for the board");
  const memoryMethods = new Set(["Memory.trackingUpdate", "Memory.memoryPressure", "Heap.garbageCollected"]);
  const oldDispatch = target.connection.dispatch.bind(target.connection);
  target.connection.dispatch = function(message) {
    const packet = typeof message === "string" ? JSON.parse(message) : message;
    if (memoryMethods.has(packet.method)) {
      if (state.samples.length === 2048) { state.samples.shift(); state.dropped++; }
      state.samples.push({method: packet.method, data: packet.params});
      return;
    }
    if (packet.method === "Memory.trackingStart" || packet.method === "Memory.trackingComplete") return;
    return oldDispatch(message);
  };
  globalThis.__nativeMemoryInspector = {
    read() {
      return {samples: state.samples.splice(0), dropped: state.dropped};
    }
  };
  const calls = {};
  for (const [domain, command] of [["Heap", "enable"], ["Memory", "enable"], ["Memory", "startTracking"]]) {
    try { await target[domain + "Agent"][command](); calls[domain + "." + command] = "ok"; }
    catch (error) { calls[domain + "." + command] = String(error); }
  }
  return {target: target.identifier, heap: target.hasDomain("Heap"), memory: target.hasDomain("Memory"), calls};
} catch (error) {
  return {error: String(error), stack: error.stack};
}
