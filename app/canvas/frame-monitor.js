"use strict";
// Help › Troubleshooting › Frame Monitor. The callback clock and editor trace
// listen only while the monitor is open, and the callback clock parks between bursts.
globalThis.AtriumFrameMonitor = (() => {
  const G = globalThis;
  const WINDOW_MS = 2000, REST_MS = 1000, UPDATE_MS = 250, LIMIT = 512;
  const CADENCE_WARMUP = 8, CADENCE_SETTLE = 12, CADENCE_SETTLE_MS = 500, CADENCE_TOLERANCE = .12;
  const t = G.AtriumI18n?.define({
    "frame.title": "Frame Monitor",
    "frame.close": "Close",
    "frame.measuring": "Sampling",
    "frame.idle": "Idle · last sampled window",
    "frame.paused": "Paused while the window is hidden",
    "frame.cadence": "Callback rate",
    "frame.cadence_value": "{fps} fps · {reference} Hz ref.",
    "frame.intervals": "Mean / p95 interval",
    "frame.intervals_value": "{mean} / {p95} ms",
    "frame.gaps": "Spikes / est. missed",
    "frame.gaps_value": "{spikes} / {missed}",
    "frame.draws": "Canvas draws",
    "frame.draws_value": "{count} in 1 s",
    "frame.draw_cpu": "Canvas draw CPU",
    "frame.commit_cpu": "Edit commit CPU",
    "frame.task_cpu": "Edit follow-up CPU",
    "frame.wheel_cpu": "Ctrl+wheel → draw",
    "frame.sample_ms": "{value} ms p95",
    "frame.last_ms": "{value} ms last",
    "frame.note": "Animation callbacks (rAF), last 2 s. The reference adjusts to sustained changes in cadence.",
    "frame.load_failed": "Could not open Frame Monitor"
  });

  function series() {
    const times = new Float64Array(LIMIT), values = new Float64Array(LIMIT);
    let next = 0, length = 0;
    return {
      add(at, value) {
        times[next] = at; values[next] = value;
        next = (next + 1) % LIMIT;
        length = Math.min(length + 1, LIMIT);
      },
      recent(since) {
        const out = [];
        for (let i = 1; i <= length; i++) {
          const index = (next - i + LIMIT) % LIMIT;
          if (times[index] < since) break;
          out.push(values[index]);
        }
        return out;
      },
      last: () => length ? values[(next + LIMIT - 1) % LIMIT] : null
    };
  }

  const sorted = values => values.sort((a, b) => a - b);
  const p95 = values => values[Math.ceil(values.length * .95) - 1] ?? null;
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const cadenceTolerance = period => Math.max(1, period * CADENCE_TOLERANCE);

  const samePane = (a, b) => a && b && a.view === b.view && a.docId === b.docId;
  function sameCamera(a, b) {
    return a.cx === b.cx && a.cy === b.cy && a.scale === b.scale && a.rotation === b.rotation && a.flipped === b.flipped;
  }

  function createSampler({now, request, cancel, publish, captureTarget, timeOrigin = 0}) {
    let intervals, draws, commits, tasks, wheelTimes, wheelPending;
    let visible = false, frame = null, lastFrame = null, lastReport, awakeUntil, visibleSince;
    let reference, referenceSince, cadenceCandidate;

    function reset() {
      intervals = series(); draws = series(); commits = series(); tasks = series(); wheelTimes = series();
      clearWheel();
      lastFrame = null; lastReport = -Infinity;
      reference = cadenceCandidate = null; referenceSince = -Infinity;
    }
    function wake(at) {
      awakeUntil = at + REST_MS;
      if (frame === null) {
        // A new burst has no interval connecting it to the previous one.
        lastFrame = cadenceCandidate = null;
        frame = request(tick);
      }
    }
    function stat(buffer, since) {
      return {p95: p95(sorted(buffer.recent(since))), last: buffer.last()};
    }
    function observeCadence(at, dt) {
      if (reference === null || Math.abs(dt - reference) <= cadenceTolerance(reference)) {
        cadenceCandidate = null;
        return;
      }
      // A long and coherent run in either direction can be a new display mode,
      // or sustained WebView pacing. An isolated slow callback keeps its spike.
      const candidate = cadenceCandidate;
      if (!candidate || Math.abs(dt - candidate.period) > cadenceTolerance(candidate.period)) {
        cadenceCandidate = {start: at, period: dt, total: dt, count: 1};
        return;
      }
      candidate.count++; candidate.total += dt;
      if (candidate.count < CADENCE_SETTLE || at - candidate.start < CADENCE_SETTLE_MS) return;
      reference = candidate.total / candidate.count;
      referenceSince = candidate.start;
      cadenceCandidate = null;
    }
    function report(at, idle) {
      const since = at - WINDOW_MS, durations = sorted(intervals.recent(Math.max(since, referenceSince)));
      if (!cadenceCandidate && durations.length >= CADENCE_WARMUP) {
        // Average the fast cadence cluster. A single fast percentile mistakes
        // clock quantization (16/17 ms at 60 Hz, 8/9 ms at 120 Hz) for a rate.
        const seed = reference ?? durations[Math.floor((durations.length - 1) * .2)];
        const tolerance = reference === null ? seed * .25 : cadenceTolerance(reference);
        const steady = durations.filter(dt => Math.abs(dt - seed) <= tolerance);
        if (steady.length >= CADENCE_WARMUP) reference = average(steady);
      }
      const mean = average(durations);
      let spikes = 0, missed = 0;
      if (reference !== null) for (const dt of durations) {
        if (dt <= reference * 1.5) continue;
        spikes++;
        missed += Math.round(dt / reference) - 1;
      }
      lastReport = at;
      publish({state: idle ? "idle" : "measuring", mean, reference, p95: p95(durations), spikes, missed,
        draws: idle ? 0 : draws.recent(at - REST_MS).length, draw: stat(draws, since),
        commit: stat(commits, since), task: stat(tasks, since), wheel: stat(wheelTimes, since)});
    }
    function tick(stamp) {
      frame = null;
      if (!visible) return;
      const at = now();
      if (lastFrame !== null && stamp > lastFrame) {
        const dt = stamp - lastFrame;
        observeCadence(at, dt);
        intervals.add(at, dt);
      }
      lastFrame = stamp;
      const idle = at >= awakeUntil;
      if (idle || at - lastReport >= UPDATE_MS) report(at, idle);
      if (!idle) frame = request(tick);
    }
    function setVisible(value) {
      if (value === visible) return;
      visible = value;
      if (!visible) {
        if (frame !== null) cancel(frame);
        frame = null;
        clearWheel();
        publish({state: "paused"});
        return;
      }
      reset();
      visibleSince = now();
      report(visibleSince, false);
      wake(visibleSince);
    }
    function record(buffer, start, end) {
      if (!visible || !Number.isFinite(start) || !Number.isFinite(end) || start < visibleSince || end < start) return false;
      buffer.add(end, end - start);
      wake(end);
      return true;
    }

    function clearWheel() { wheelPending = null; }
    const trace = {
      draw(canvas, start, end) {
        if (!record(draws, start, end)) return;
        const pending = wheelPending?.get(canvas);
        if (!pending) return;
        wheelPending.delete(canvas);
        if (pending.event > start || end - pending.event > 5000) return;
        const target = captureTarget(canvas);
        if (samePane(pending.target, target) && sameCamera(pending.target.camera, target.camera)) {
          wheelTimes.add(end, end - pending.event);
        }
      },
      wheel(canvas, stamp) {
        if (!visible || !Number.isFinite(stamp) || stamp <= 0) return;
        const at = now();
        const event = stamp > at && timeOrigin ? stamp - timeOrigin : stamp;
        if (event < visibleSince || event > at || at - event > 5000) return;
        const target = captureTarget(canvas);
        if (!target) return;
        wheelPending ??= new WeakMap();
        // Multiple input mutations in the same pane can contribute to one draw.
        const pending = wheelPending.get(canvas);
        const first = pending && at - pending.event <= 5000 && samePane(pending.target, target) ? Math.min(event, pending.event) : event;
        wheelPending.set(canvas, {event: first, target});
        wake(at);
      },
      commit: (start, end) => record(commits, start, end),
      editTask: (start, end) => record(tasks, start, end)
    };
    return {setVisible, trace, clearWheel};
  }

  let remove = null, opening = null;
  function mount(kit) {
    const doc = G.document, power = G.AtriumPower;
    const frameClock = G.AtriumIdle;
    const value = label => kit.propRow(label, "—");
    const cadence = value(t("frame.cadence")), interval = value(t("frame.intervals")), gaps = value(t("frame.gaps"));
    const draws = value(t("frame.draws")), draw = value(t("frame.draw_cpu")), commit = value(t("frame.commit_cpu"));
    const task = value(t("frame.task_cpu")), wheel = value(t("frame.wheel_cpu"));
    const status = kit.el("p", "ui-section-note", t("frame.measuring"));
    const note = kit.el("p", "ui-section-note", t("frame.note"));
    const close = kit.button(t("frame.close"), {variant: "quiet", size: "sm", run: end});
    const panel = kit.panel({title: t("frame.title"), actions: [close],
      body: [status, cadence, interval, gaps, draws, draw, commit, task, wheel, note]});
    panel.id = "frame-monitor";
    panel.classList.add("ui-popover");
    panel.style.cssText = "position:fixed;inset-inline-end:var(--s-16);inset-block-end:calc(var(--chrome-row-height) + var(--s-16));inline-size:min(350px,calc(100vw - 2 * var(--s-16)));max-block-size:calc(100dvh - 3 * var(--chrome-row-height));z-index:var(--z-popover)";
    const heading = panel.querySelector("h2");
    heading.id = "frame-monitor-title";
    panel.setAttribute("aria-labelledby", heading.id);
    panel.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); end();
    });

    const number = new Intl.NumberFormat(G.AtriumI18n.locale(), {maximumFractionDigits: 1});
    const int = new Intl.NumberFormat(G.AtriumI18n.locale(), {maximumFractionDigits: 0});
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    const cell = (row, text) => set(row.lastElementChild, text ?? "—");
    const cpu = stat => stat?.p95 != null ? t("frame.sample_ms", {value: number.format(stat.p95)}) :
      stat?.last != null ? t("frame.last_ms", {value: number.format(stat.last)}) : null;
    function publish(sample) {
      const {state, mean, reference, p95, spikes, missed} = sample;
      if (panel.dataset.state !== state) panel.dataset.state = state;
      set(status, state === "paused" ? t("frame.paused") : state === "idle" ? t("frame.idle") : t("frame.measuring"));
      cell(cadence, reference !== null && mean > 0 ? t("frame.cadence_value", {fps: number.format(1000 / mean), reference: int.format(1000 / reference)}) : null);
      cell(interval, mean > 0 ? t("frame.intervals_value", {mean: number.format(mean), p95: number.format(p95)}) : null);
      cell(gaps, reference != null && mean > 0 ? t("frame.gaps_value", {spikes: int.format(spikes), missed: int.format(missed)}) : null);
      cell(draws, sample.draws != null ? t("frame.draws_value", {count: int.format(sample.draws)}) : null);
      cell(draw, cpu(sample.draw)); cell(commit, cpu(sample.commit)); cell(task, cpu(sample.task)); cell(wheel, cpu(sample.wheel));
    }
    const nav = G.AtriumNavHost;
    const sampler = createSampler({
      now: () => performance.now(), timeOrigin: performance.timeOrigin,
      request: frameClock.sampleFrame, cancel: frameClock.cancelSample, publish,
      captureTarget(canvas) {
        const pane = nav.panes().find(p => p.canvas === canvas);
        return pane && {view: pane.view, docId: pane.docId, camera: pane.view.camera()};
      }
    });
    function visibility() {
      const visible = power.visible();
      if (visible) G.__waffleFrameTrace = sampler.trace;
      else if (G.__waffleFrameTrace === sampler.trace) delete G.__waffleFrameTrace;
      sampler.setVisible(visible);
    }
    const unsubscribe = [
      power.onChange(visibility),
      nav.on("document", sampler.clearWheel),
      nav.on("replace", sampler.clearWheel)
    ];
    const menu = doc.querySelector('[data-action="frame-monitor"]');
    function end() {
      if (G.__waffleFrameTrace === sampler.trace) delete G.__waffleFrameTrace;
      for (const off of unsubscribe) off();
      sampler.setVisible(false);
      const focused = panel.contains(doc.activeElement);
      panel.remove(); remove = null;
      menu?.setAttribute("aria-checked", "false");
      if (focused) G.AtriumShell?.focusEditor?.();
    }
    publish({state: "paused"});
    doc.body.append(panel);
    menu?.setAttribute("aria-checked", "true");
    close.focus({preventScroll: true});
    visibility();
    return end;
  }

  async function toggle() {
    if (remove) return remove();
    if (opening) { opening = null; return; }
    const ticket = {};
    opening = ticket;
    try {
      const kit = G.AtriumUIKit || await G.AtriumLazy.need("AtriumUIKit");
      if (opening === ticket) remove = mount(kit);
    } catch {
      if (opening === ticket) G.AtriumNavHost?.info?.(t("frame.load_failed"));
    } finally {
      if (opening === ticket) opening = null;
    }
  }

  G.AtriumNavHost?.registerAction("frame-monitor", toggle);
  return Object.freeze({createSampler});
})();
