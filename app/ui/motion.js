"use strict";
// Visual transitions for visibility and layout changes. The caller owns the
// underlying UI state and focus. DOM animations use the compositor, not a JS loop.
globalThis.AtriumMotionUI = (() => {
  const G = globalThis, active = new Map(), properties = ["transform", "opacity"];
  const disabledListeners = new Map();
  const hidden = Object.freeze({transform: "scale(.97)", opacity: 0});
  const fallbackCurve = "cubic-bezier(.23,1,.32,1)";
  let reduced, hoverQuery, stopWatching;

  function systemMotion() {
    if (reduced === undefined) reduced = G.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    return reduced;
  }
  function intentOf(input) {
    if (input === "keyboard" || input === "pointer") return input;
    if (input?.type?.startsWith("key") || input?.type === "click" && input.detail === 0) return "keyboard";
    if (input?.type) return "pointer";
    return G.document?.documentElement?.getAttribute?.("data-motion-input") || "pointer";
  }
  function eligible(input) {
    const root = G.document?.documentElement;
    return intentOf(input) !== "keyboard" && root?.getAttribute?.("data-motion") !== "off" &&
      !root?.hasAttribute?.("data-efficient") && !G.AtriumPower?.efficient?.();
  }
  const visible = () => G.document?.visibilityState !== "hidden" && G.AtriumPower?.visible?.() !== false;
  const enabled = input => eligible(input) && visible();
  const allowTravel = () => G.document?.documentElement?.getAttribute?.("data-motion") !== "reduce" && !systemMotion()?.matches;
  const moves = input => enabled(input) && allowTravel();
  function hover(input) {
    if (!enabled(input)) return false;
    if (hoverQuery === undefined) hoverQuery = G.matchMedia?.("(hover:hover) and (pointer:fine)") ?? null;
    return !!hoverQuery?.matches;
  }
  function refresh() {
    const fade = eligible(), shown = visible(), move = fade && allowTravel();
    for (const track of [...active.values()]) {
      if (!fade) finish(track, true);
      else if (!move && track.keys.includes("transform")) {
        if (!track.keys.includes("opacity") || !track.animation.effect?.setKeyframes) finish(track, true);
        else {
          track.keys = ["opacity"];
          track.animation.effect.setKeyframes(track.frames.map(({opacity}) => ({opacity})));
        }
      }
      if (!track.live || track.paused === !shown) continue;
      track.paused = !shown;
      if (shown) track.animation.play();
      else {
        const at = track.animation.currentTime;
        track.animation.pause();
        if (at !== null) track.animation.currentTime = at;
      }
    }
    for (const [callback,spatial] of [...disabledListeners]) {
      if ((!shown || !fade || spatial && !move) && disabledListeners.delete(callback)) callback();
    }
    stopIfIdle();
  }
  function watch() {
    if (stopWatching) return;
    const media = systemMotion(), doc = G.document, root = doc?.documentElement;
    const observer = root && G.MutationObserver ? new G.MutationObserver(refresh) : null;
    observer?.observe(root, {attributes:true, attributeFilter:["data-motion", "data-motion-input", "data-efficient"]});
    media?.addEventListener?.("change", refresh);
    doc?.addEventListener?.("visibilitychange", refresh);
    const unpower = G.AtriumPower?.onChange?.(refresh);
    stopWatching = () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", refresh);
      doc?.removeEventListener?.("visibilitychange", refresh);
      unpower?.();
      stopWatching = null;
    };
  }
  function stopIfIdle() {
    if (!active.size && !disabledListeners.size) stopWatching?.();
  }
  function whenDisabled(callback, {spatial = false} = {}) {
    if (!(spatial ? moves() : enabled())) {
      callback();
      return () => {};
    }
    disabledListeners.set(callback,spatial);
    watch();
    return () => {
      disabledListeners.delete(callback);
      stopIfIdle();
    };
  }
  function finish(track, completed) {
    if (!track.live) return;
    track.live = false;
    if (active.get(track.element) === track) active.delete(track.element);
    stopIfIdle();
    track.animation.cancel();
    track.resolve(completed);
    if (completed && track.done) {
      try { track.done(); } catch (error) { G.console?.error?.(error); }
    }
  }
  function cancel(element, {finish: complete = false} = {}) {
    const track = active.get(element);
    if (track) finish(track, complete);
  }
  function immediate(done) {
    done?.();
    return {running:false, finished:Promise.resolve(true), cancel() {}};
  }
  function framesOf(base, start, target, previous) {
    const from = {}, to = {};
    for (const key of properties) {
      if (!(key in start) && !(key in target) && !previous?.keys.includes(key)) continue;
      from[key] = previous ? previous.style[key] : (start[key] ?? base[key]);
      to[key] = target[key] ?? base[key];
    }
    return [from, to];
  }
  function transition(element, start, target, {curve = "decelerate", duration = "base", delay = 0, intent, done} = {}) {
    const old = active.get(element);
    if (!enabled(intent) || typeof element?.animate !== "function" || typeof G.getComputedStyle !== "function") {
      cancel(element);
      return immediate(done);
    }
    // ComputedStyle is live. Copy the evaluated values before cancelling the old effect.
    const live = old && G.getComputedStyle(element);
    const previous = old && {keys:old.keys, style:{transform:live.transform, opacity:live.opacity}};
    cancel(element);
    const base = G.getComputedStyle(element);
    const frames = framesOf(base,start,target,previous);
    if (!moves(intent)) for (const frame of frames) delete frame.transform;
    const keys = Object.keys(frames[0]);
    const token = typeof duration === "string" ? base.getPropertyValue("--motion-" + duration).trim() : "";
    const ms = Math.min(299,typeof duration === "number" ? duration :
      token.endsWith("ms") ? Number.parseFloat(token) : Number.parseFloat(token) * 1000);
    if (!keys.length || !Number.isFinite(ms) || ms <= 0 || keys.every(key => String(frames[0][key]) === String(frames[1][key])))
      return immediate(done);

    const easing = base.getPropertyValue("--ease-" + curve).trim() || fallbackCurve;
    const lag = Math.max(0,Math.min(delay,299-ms));
    const timing = {duration:ms,easing,fill:"both",...(lag > 0 && {delay:lag})};
    let animation;
    try { animation = element.animate(frames,timing); }
    catch {
      try { animation = element.animate(frames,{...timing,easing:fallbackCurve}); }
      catch { return immediate(done); }
    }
    let resolve;
    const finished = new Promise(end => { resolve = end; });
    const track = {element,animation,frames,keys,done,resolve,live:true,paused:false};
    active.set(element,track);
    watch();
    animation.finished.then(() => finish(track,true), () => finish(track,false))
      .catch(error => G.console?.error?.(error));
    return {get running() { return track.live; }, finished,
      cancel({finish:complete = false} = {}) { finish(track,complete); }};
  }
  function enter(element, {from = hidden, to = {}, ...options} = {}) {
    return transition(element, from, to, options);
  }
  function exit(element, {from = {}, to = hidden, ...options} = {}) {
    return transition(element, from, to, options);
  }
  function swap(outgoing, incoming, options = {}) {
    return {exit:outgoing && outgoing !== incoming ? exit(outgoing,options.exit) : null,
      enter:incoming ? enter(incoming,options.enter) : null};
  }
  function flip(elements, mutate, options) {
    if (!moves(options?.intent)) {
      mutate();
      return [];
    }
    // All reads precede each layout write. Capturing the current animated rect
    // also makes a second relayout continue from the position already on screen.
    const first = new Map([...elements].filter(el => typeof el.animate === "function")
      .map(el => [el,{rect:el.getBoundingClientRect(),
        opacity:active.get(el)?.keys.includes("opacity") ? G.getComputedStyle(el).opacity : undefined}]));
    for (const el of first.keys()) cancel(el);
    mutate();
    const targets = [];
    for (const [el,{rect:before,opacity}] of first) {
      if (!el.isConnected) continue;
      const after = el.getBoundingClientRect();
      if (!after.width || !after.height || !before.width || !before.height) continue;
      const dx = before.left - after.left, dy = before.top - after.top;
      const sx = before.width / after.width, sy = before.height / after.height;
      if (!dx && !dy && sx === 1 && sy === 1 && opacity === undefined) continue;
      const style = G.getComputedStyle(el);
      const [ox,oy] = style.transformOrigin.split(" ").map(Number.parseFloat);
      const x = dx + (sx-1)*(ox || 0), y = dy + (sy-1)*(oy || 0);
      const rest = style.transform === "none" ? "" : " " + style.transform;
      targets.push([el,{transform:"translate(" + x + "px," + y + "px) scale(" + sx + "," + sy + ")" + rest,
        ...(opacity !== undefined && {opacity})}]);
    }
    return targets.map(([element,from]) => enter(element,{from,...options}));
  }

  const closingDetails = new WeakMap();
  function disclosure(details, summary, body, event) {
    const opening = !details.open || closingDetails.has(details);
    if (!enabled(event)) {
      closingDetails.delete(details);
      details.classList.remove("ui-detail-closing");
      details.open = opening;
      summary.removeAttribute("aria-expanded");
      body.inert = !opening;
      return;
    }
    if (opening) {
      closingDetails.delete(details);
      details.classList.add("ui-detail-closing");
      details.open = true;
      void body.offsetHeight;
      details.classList.remove("ui-detail-closing");
      summary.removeAttribute("aria-expanded");
      body.inert = false;
      return;
    }
    details.classList.add("ui-detail-closing");
    summary.setAttribute("aria-expanded","false");
    body.inert = true;
    const fade = body.getAnimations?.().find(animation => animation.transitionProperty === "opacity");
    closingDetails.set(details,fade);
    const finish = () => {
      if (closingDetails.get(details) !== fade || !details.classList.contains("ui-detail-closing")) return;
      closingDetails.delete(details);
      details.open = false;
      details.classList.remove("ui-detail-closing");
      summary.removeAttribute("aria-expanded");
    };
    if (fade) fade.finished.then(finish,finish); else finish();
  }

  return Object.freeze({enter, exit, swap, cancel, flip, disclosure, enabled, moves, hover, refresh, whenDisabled, active:() => active.size});
})();
