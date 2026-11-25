"use strict";
// Orders follow-up work after an edit frame. Each consumer reads the undo journal
// from its own last applied cursor, so replacing work never discards model changes.
globalThis.AtriumEditPipeline = (() => {
  const phases = Object.freeze({connectivity: 0, airwires: 1, pours: 2, rules: 3, idle: 4});

  function create(idle, visible, nextTask = callback => setTimeout(callback, 0), now = () => performance.now()) {
    const pending = new Map(), newest = new Map(), holds = new Map();
    let turn = null, waitingIdle = null, painted = false, running = false;

    function cancelIdle() {
      if (!waitingIdle) return;
      idle.cancel(waitingIdle.id);
      waitingIdle = null;
    }
    function next() {
      let first;
      let before = Infinity;
      for (const rank of holds.values()) before = Math.min(before, rank);
      for (const job of pending.values()) if (job.phase < before && (!first || job.phase < first.phase)) first = job;
      return first;
    }
    function run(job, deadline) {
      if (!job || !visible()) return;
      running = true;
      const trace = globalThis.__waffleFrameTrace, start = now(), end = start + 6;
      const slice = {timeRemaining: () => Math.max(0, end - now())};
      try {
        pending.delete(job.key);
        job.callback(job.current, job.short && job.phase === phases.airwires ? slice : deadline);
        // Run short adjacent phases in one task if there is time. If airwires
        // yield and enqueue another slice, the next task still runs it before tiles.
        while (painted && visible() && job.phase < phases.pours && slice.timeRemaining() >= 2) {
          const following = next();
          if (!following?.short || following.phase <= job.phase || following.phase > phases.pours) break;
          job = following;
          pending.delete(job.key);
          job.callback(job.current, slice);
        }
      } finally { trace?.editTask(start, now()); running = false; resume(); }
    }
    function resume() {
      if (running || turn || waitingIdle || !visible() || !next()) return;
      const ticket = {};
      turn = ticket;
      const deliver = () => {
        if (turn !== ticket) return;
        turn = null;
        if (!visible()) return;
        painted = true;
        const job = next();
        if (job?.phase === phases.idle) {
          waitingIdle = ticket;
          ticket.id = idle.idle(deadline => {
            if (waitingIdle !== ticket) return;
            waitingIdle = null;
            run(next(), deadline);
          }, {timeout: 1500});
        } else run(job);
      };
      // Wait for pixels once. Later phases yield to input without reserving another frame.
      if (painted) nextTask(deliver); else idle.afterFrame(deliver);
    }
    function stage(phase, key, callback, {short = false} = {}) {
      const rank = phases[phase];
      if (typeof rank !== "number") throw new RangeError("Unknown edit phase: " + phase);
      const token = {};
      const current = () => newest.get(key) === token;
      const job = {key, phase: rank, callback, current, short};
      newest.set(key, token);
      pending.set(key, job);
      if (rank < phases.idle) cancelIdle();
      resume();
      return {current, cancel() {
        if (!current()) return;
        newest.delete(key);
        pending.delete(key);
        if (!pending.size) cancelIdle();
      }};
    }
    function suspend() {
      turn = null;
      painted = false;
      cancelIdle();
    }
    function supersede() {
      suspend();
      pending.clear();
      newest.clear();
    }
    function holdFrom(phase, maxMs = 0) {
      const rank = phases[phase];
      if (typeof rank !== "number") throw new RangeError("Unknown edit phase: " + phase);
      const token = {};
      holds.set(token, rank);
      cancelIdle();
      let timer = 0;
      function release() {
        if (holds.delete(token)) { clearTimeout(timer); resume(); }
      }
      if (maxMs > 0) timer = setTimeout(release, maxMs);
      return release;
    }
    return {stage, supersede, suspend, resume, holdFrom, holdIdle: maxMs => holdFrom("idle", maxMs)};
  }
  return Object.freeze({create});
})();
