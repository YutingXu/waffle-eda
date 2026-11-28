"use strict";
// AtriumMotion: the motion system's JavaScript side (docs/motion.md).
//
// Tokens. duration(name) and ease(name) mirror the CSS tokens in style.css :root (--motion-instant,
// --motion-fast, --motion-base, --motion-slow, --motion-ambient; --ease-standard, -decelerate,
// -accelerate, -spring, -drawer). tests/motion.cjs checks that the two stay equal.
//
// Levels. level() is "full", "reduced" or "off": data-motion on <html> (Preferences › Appearance ›
// Animations: "full", "reduce", "off"), else "off" in Efficiency mode (power.js), else the system's prefers-reduced-motion. Reduced keeps fades
// and drops travel (moves() is false), Off keeps nothing (duration() is 0 and animate() lands at once).
//
// Canvas. On the editor's existing renderer (AtriumNavHost overlay + pointer-only redraws), one
// requestAnimationFrame loop runs only while something animates; idle costs nothing:
//   - undo / redo pulse what changed (editor.js calls undone()), removed objects fade out dashed;
//   - a placed part settles (a ring closes onto it);
//   - big changes cross-fade instead of popping: DRC markers, pours after a repour,
//     an autoroute or another large commit.
// Every effect is interruptible: pointer, wheel and key input cancel cross-fades, and a new effect of
// the same kind replaces the old one. Per frame nothing is allocated.
//
// Theme. crossFade(fn) presents a compositor snapshot around a theme change (theme.js).
// Lazy: lazy.js prefetches it with the camera when the editor is idle; nothing needs it at startup
// (CSS carries the UI motion on its own).
globalThis.AtriumMotion = (() => {
  const G = globalThis;
  const DURATIONS = Object.freeze({instant:80, fast:140, base:200, slow:320, ambient:240});
  const out = Object.freeze([.23,1,.32,1]), inOut = Object.freeze([.77,0,.175,1]);
  const EASES = Object.freeze({
    standard:inOut,
    decelerate:out,
    accelerate:out,
    spring:out,
    drawer:Object.freeze([.32,.72,0,1]),
    linear: Object.freeze([0, 0, 1, 1]),
  });
  const PRESETS = Object.freeze({fast:"fast", standard:"base", gentle:"slow"});
  const realNow = () => G.performance?.now?.() ?? Date.now();
  const hidden = () => G.document?.visibilityState === "hidden" || G.AtriumPower?.visible?.() === false;
  let pausedAt = null, pausedTime = 0;
  const now = () => (pausedAt ?? realNow()) - pausedTime;

  // ---------------------------------------------------------------- levels
  let reduceQuery;
  function osReduced() {
    try { if (reduceQuery === undefined) reduceQuery = G.matchMedia?.("(prefers-reduced-motion: reduce)") || null; } catch { reduceQuery = null; }
    return reduceQuery?.matches === true;
  }
  const effectiveLevel = (requested, input, efficient, reduced) =>
    requested === "off" || input === "keyboard" || efficient ? "off" : requested === "reduce" || reduced ? "reduced" : "full";
  function efficient() {
    try { return G.AtriumPower?.efficient?.() === true; } catch { return false; }
  }
  function level(ignoreInput = false) {
    const root = G.document?.documentElement;
    return effectiveLevel(root?.getAttribute?.("data-motion"), ignoreInput ? "pointer" : root?.getAttribute?.("data-motion-input"),
      efficient(), osReduced());
  }
  function describePolicy(options = {}) {
    const root = G.document?.documentElement;
    const requested = options.requested ?? root?.getAttribute?.("data-motion") ?? "system";
    const input = options.input ?? root?.getAttribute?.("data-motion-input") ?? "pointer";
    const reduced = options.osReduced ?? osReduced(), efficiency = options.efficient ?? efficient();
    const visibility = options.visibility ?? (G.document?.visibilityState === "hidden" ? "hidden" : hidden() ? "occluded" : "visible");
    const pointerHover = options.pointerHover ?? (G.matchMedia?.("(hover:hover) and (pointer:fine)")?.matches === true);
    const level = effectiveLevel(requested,input,efficiency,reduced), suspended = visibility !== "visible";
    return {requested,input,visibility,osReduced:reduced,efficient:efficiency,level,suspended,
      opacity:level !== "off",travel:level === "full",hover:pointerHover && level !== "off" && !suspended};
  }
  const moves = () => level() === "full";     // travel, scale, camera flights
  const enabled = () => level() !== "off";    // fades

  // ---------------------------------------------------------------- tokens
  function durationValue(name) {
    const v = typeof name === "number" ? name : DURATIONS[name];
    if (!Number.isFinite(v)) throw Error("Unknown motion duration: " + name);
    return v;
  }
  function duration(name) {
    const ms = durationValue(name);
    return level() === "off" ? 0 : ms;
  }
  const boundedDuration = (name,camera) => Math.max(0,Math.min(durationValue(name),camera ? DURATIONS.slow : 299));
  // cubic-bezier(x1, y1, x2, y2) as a function of t in [0, 1]: Newton steps, then bisection.
  function bezier([x1, y1, x2, y2]) {
    if (x1 === y1 && x2 === y2) return t => t;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = s => ((ax * s + bx) * s + cx) * s, Y = s => ((ay * s + by) * s + cy) * s, dX = s => (3 * ax * s + 2 * bx) * s + cx;
    return t => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      let s = t;
      for (let i = 0; i < 8; i++) { const e = X(s) - t, d = dX(s); if (Math.abs(e) < 1e-6) return Y(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
      let lo = 0, hi = 1; s = t;
      for (let i = 0; i < 30; i++) { const x = X(s); if (Math.abs(x - t) < 1e-6) break; if (x < t) lo = s; else hi = s; s = (lo + hi) / 2; }
      return Y(s);
    };
  }
  const curves = new Map();
  function ease(name = "standard") {
    let f = curves.get(name);
    if (!f) { const p = EASES[name]; if (!p) throw Error("Unknown motion easing: " + name); f = bezier(p); curves.set(name, f); }
    return f;
  }
  const cssEase = name => { const p = EASES[name]; if (!p) throw Error("Unknown motion easing: " + name); return name === "linear" ? "linear" : "cubic-bezier(" + p.join(",") + ")"; };
  const progressAt = (elapsed,ms) => ms <= 0 ? 1 : Math.max(0,Math.min(1,elapsed / ms));
  function plan({kind = "fade", duration:token = "base", durationMs, curve = "standard", level, visibility} = {}) {
    const policy = describePolicy({visibility});
    const effective = level ?? policy.level, surface = visibility ?? policy.visibility;
    const camera = kind === "camera", track = {kind:camera ? "travel" : kind};
    const requested = boundedDuration(durationMs ?? token,camera);
    const ms = shouldLand(track,effective) ? 0 : requested;
    return {kind,level:effective,visibility:surface,duration:durationMs === undefined ? token : null,durationMs:ms,
      curve,cssEasing:cssEase(curve),disposition:!ms ? "immediate" : surface === "visible" ? "scheduled" : "paused"};
  }
  function sample({from,to,elapsedMs,durationMs,curve = "standard",kind = "fade"}) {
    const ms = boundedDuration(durationMs,kind === "camera"), progress = progressAt(elapsedMs,ms), eased = ease(curve)(progress);
    return {progress,eased,value:from * (1 - eased) + to * eased,finished:progress === 1,durationMs:ms};
  }
  function retarget({from,previousTarget,to,elapsedMs,durationMs,nextDurationMs,curve = "standard",kind = "fade"}) {
    const seen = sample({from,to:previousTarget,elapsedMs,durationMs,curve,kind});
    return {previous:seen,from:seen.value,to,durationMs:boundedDuration(nextDurationMs ?? durationMs,kind === "camera"),curve,kind};
  }

  // ---------------------------------------------------------------- one loop for every animation
  const tracks = new Set(), channels = new WeakMap();
  let raf = null, ticking = false, sequence = 0, stopWatching = null;
  function unschedule() {
    if (raf !== null) G.cancelAnimationFrame?.(raf);
    raf = null;
  }
  function updateClock() {
    if (hidden()) {
      pausedAt ??= realNow();
      unschedule();
    } else if (pausedAt !== null) {
      pausedTime += realNow() - pausedAt;
      pausedAt = null;
    }
  }
  function watchClock() {
    if (stopWatching) return;
    const doc = G.document, root = doc?.documentElement;
    const observer = root && G.MutationObserver ? new G.MutationObserver(syncPolicy) : null;
    observer?.observe(root, {attributes:true, attributeFilter:["data-motion", "data-motion-input", "data-efficient"]});
    doc?.addEventListener?.("visibilitychange", syncPolicy);
    reduceQuery?.addEventListener?.("change", syncPolicy);
    const unpower = G.AtriumPower?.onChange?.(syncPolicy);
    stopWatching = () => {
      observer?.disconnect();
      doc?.removeEventListener?.("visibilitychange", syncPolicy);
      reduceQuery?.removeEventListener?.("change", syncPolicy);
      unpower?.();
      stopWatching = null;
    };
  }
  function schedule() {
    if (!tracks.size && !fxCount) return cancelIdleFrame();
    watchClock();
    updateClock();
    if (raf === null && !ticking && pausedAt === null && G.requestAnimationFrame) raf = G.requestAnimationFrame(tick);
  }
  function cancelIdleFrame() {
    if (!tracks.size && !fxCount) { unschedule(); stopWatching?.(); }
  }
  function tick(t0) {
    raf = null;
    updateClock();
    if (pausedAt !== null) return;
    ticking = true;
    try {
      const at = (Number.isFinite(t0) ? t0 : realNow()) - pausedTime, policy = level();
      // New tracks from callbacks wait for the next display frame.
      const through = sequence;
      for (const k of tracks) {
        if (k.id > through) break;
        k.start ??= at;
        const t = shouldLand(k, policy) ? 1 : progressAt(at - k.start,k.ms);
        try { k.step(k.ease(t), t); } catch (e) { G.console?.error?.(e); }
        if (t === 1 && removeTrack(k)) try { k.done?.(); } catch (e) { G.console?.error?.(e); }
      }
      tickEffects();
    } finally {
      ticking = false;
      schedule();
    }
  }
  function removeTrack(track) {
    const removed = tracks.delete(track);
    cancelIdleFrame();
    return removed;
  }
  const shouldLand = (track, policy) => policy === "off" || policy === "reduced" && track.kind === "travel";
  function animate({ms, duration: name = "base", ease: e = "standard", camera = false, kind = camera ? "travel" : "fade",
    fromInput = false, step = () => {}, done} = {}) {
    updateClock();
    const k = {id:++sequence, start:fromInput ? now() : null, ms:boundedDuration(ms ?? name,camera),
      ease:ease(e), kind, step, done};
    const handle = {cancel(land = false) { if (removeTrack(k) && land) { step(1, 1); done?.(); } }, get running() { return tracks.has(k); }};
    k.handle = handle;
    if (k.ms <= 0 || shouldLand(k, level()) || !G.requestAnimationFrame) { step(1, 1); done?.(); }
    else { tracks.add(k); schedule(); }
    return handle;
  }
  const active = () => tracks.size;

  // The owner commits state first. Each replacement starts at the displayed value.
  function choreograph(owner, channel, {preset = "standard", ease: curve = "standard", kind = "travel", ms, camera = false, sample, step, done}) {
    const token = PRESETS[preset];
    if (!token) throw Error("Unknown motion preset: " + preset);
    let slots = channels.get(owner);
    if (!slots) { slots = new Map(); channels.set(owner, slots); }
    const source = sample?.();
    slots.get(channel)?.cancel();
    let track;
    const slot = {cancel(land) { track?.cancel(land); if (slots.get(channel) === slot) slots.delete(channel); },
      get running() { return !!track?.running; }};
    slots.set(channel, slot);
    track = animate({ms, duration:token, ease:curve, kind, camera, fromInput:true,
      step:(e,t) => step(e,t,source), done() { if (slots.get(channel) === slot) { slots.delete(channel); done?.(); } }});
    return slot;
  }

  // A guide commits its destination once. Retargeting continues from the displayed rectangle.
  const guides = new WeakMap(), boxEdges = ["left", "top", "width", "height"];
  const butterEnabled = () => G.AtriumLabs?.butterEnabled?.("motion") === true;
  function placeBox(element, box, {direct = false} = {}) {
    if (!element) return;
    const style = element.style;
    let guide = guides.get(element);
    if (!box) {
      guide?.handle?.cancel(); guides.delete(element); style.transform = "";
      if (guide) style.transformOrigin = guide.origin;
      return;
    }
    if (guide && (!direct || !guide.handle?.running) && boxEdges.every(key => guide.target[key] === box[key])) return;
    if (!guide) { guide = {origin:style.transformOrigin}; guides.set(element,guide); }
    const from = guide.shown;
    guide.handle?.cancel(); guide.target = {...box};
    for (const key of boxEdges) style[key] = box[key] + "px";
    if (!from || direct || !moves() || !box.width || !box.height) { guide.shown = {...box}; style.transform = ""; return; }
    const shown = guide.shown = {...from};
    style.transformOrigin = "top left";
    function paint(e) {
      for (const key of boxEdges) shown[key] = from[key] + (box[key] - from[key]) * e;
      style.transform = e === 1 ? "" : `translate(${shown.left - box.left}px,${shown.top - box.top}px) scale(${shown.width / box.width},${shown.height / box.height})`;
    }
    paint(0);
    guide.handle = choreograph(element,"drop-guide",{preset:"fast",step:paint});
  }
  function syncPolicy() {
    updateClock();
    const policy = level(), through = sequence;
    for (const k of tracks) {
      if (k.id > through) break;
      if (shouldLand(k, policy)) try { k.handle.cancel(true); } catch (e) { G.console?.error?.(e); }
    }
    if (policy === "reduced") for (const effect of Object.values(fx)) { if (effect) effect.move = false; }
    if (fxCount && level(true) === "off") {
      for (const name of Object.keys(fx)) end(name);
      H?.redrawOverlay?.();
    }
    schedule();
  }

  // CSS-owned compositor tracks are separate from the frame loop. Touch them only on visibility
  // changes or when a CSS effect starts while hidden. View-transition snapshots have their own owner.
  const pausedStyles = new Set(), visibleDelays = new Set();
  let stylesHidden = false;
  // A reading interval spends no frame callbacks and counts only time the surface is visible.
  function afterVisible(ms, done) {
    updateClock();
    const deadline = now() + Math.max(0, ms);
    let timer = null;
    const delay = {
      pause() { if (timer !== null) clearTimeout(timer); timer = null; },
      resume() {
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          if (hidden()) { syncStyleVisibility(); return; }
          visibleDelays.delete(delay);
          done();
        },Math.max(0,deadline - now()));
      },
      cancel() { delay.pause(); visibleDelays.delete(delay); },
    };
    visibleDelays.add(delay);
    if (!hidden()) delay.resume();
    return delay;
  }
  function pauseStyles(target) {
    for (const animation of target?.getAnimations?.() || []) {
      const css = typeof animation.transitionProperty === "string" || typeof animation.animationName === "string";
      if (!css || animation.playState !== "running" || animation.animationName === "atrium-theme-out") continue;
      const at = animation.currentTime;
      animation.pause();
      if (at !== null) animation.currentTime = at;
      pausedStyles.add(animation);
    }
  }
  const styleStarted = e => pauseStyles(e.target);
  function syncStyleVisibility() {
    updateClock();
    const next = hidden(), doc = G.document;
    if (!doc || next === stylesHidden) return;
    stylesHidden = next;
    for (const delay of visibleDelays) { if (next) delay.pause(); else delay.resume(); }
    doc.documentElement?.toggleAttribute?.("data-motion-paused",next);
    if (next) {
      pauseStyles(doc);
      doc.addEventListener?.("transitionrun",styleStarted,true);
      doc.addEventListener?.("animationstart",styleStarted,true);
    } else {
      doc.removeEventListener?.("transitionrun",styleStarted,true);
      doc.removeEventListener?.("animationstart",styleStarted,true);
      for (const animation of pausedStyles) if (animation.playState === "paused" && animation.effect?.target?.isConnected) animation.play();
      pausedStyles.clear();
    }
  }

  // ---------------------------------------------------------------- theme cross-fade
  let themeFade = null;
  const themeSnapshot = "::view-transition-old(root)";
  function paintTheme(track) {
    const apply = track.apply;
    if (!apply) return;
    track.apply = null;
    track.live = track.target;
    apply();
  }
  function finishThemeFade(track, skip = false) {
    if (themeFade !== track) return;
    themeFade = null;
    track.unwatch?.();
    if (track.frame) G.cancelAnimationFrame(track.frame);
    if (track.timer) clearTimeout(track.timer);
    const root = G.document.documentElement;
    root.removeAttribute("data-theme-fading");
    root.removeAttribute("data-theme-live");
    if (skip) track.transition?.skipTransition();
    track.overlay?.cancel();
    paintTheme(track);
  }
  function animateSnapshot(track, keyframes, ms) {
    let animation;
    try {
      animation = G.document.documentElement.animate(keyframes,
        {duration:Math.max(1,ms),fill:"both",pseudoElement:themeSnapshot});
      if (animation.effect?.pseudoElement === themeSnapshot) {
        track.overlay?.cancel();
        track.overlay = animation;
        return animation;
      }
    } catch { /* This engine cannot drive the snapshot through Web Animations. */ }
    animation?.cancel();
    finishThemeFade(track,true);
    return null;
  }
  function aimTheme(track) {
    const {effect,target,from,live} = track, change = ++track.change;
    const sameLive = target === live, sameOld = target === from;
    const current = () => themeFade === track && change === track.change;
    if (track.frame) {G.cancelAnimationFrame(track.frame); track.frame = 0;}
    if (track.timer) {clearTimeout(track.timer); track.timer = 0;}
    if (!track.overlay && (sameLive || sameOld)) {
      if (sameLive) paintTheme(track);
      else if (!effect.currentTime) {finishThemeFade(track,true); return;}
      effect.updatePlaybackRate(sameLive ? 1 : -1);
      effect.play();
      if (sameOld) effect.finished.then(() => { if (current()) paintTheme(track); },() => {});
      return;
    }

    // Pause the old fade to retain its captured image. Scripted animation paces
    // both opacity legs without resetting a running CSS animation in WebKit.
    const root = G.document.documentElement;
    const opacity = Number.parseFloat(G.getComputedStyle(root,themeSnapshot).opacity);
    if (!Number.isFinite(opacity)) {finishThemeFade(track,true); return;}
    const end = sameLive ? 0 : 1, distance = Math.abs(end - opacity);
    const replace = !sameLive && !sameOld, budget = DURATIONS.base, hold = 48;
    const leg = replace ? (budget - hold) * distance / (distance + 1) : budget * distance;
    effect.pause();
    const keyframes = replace ? [
      {opacity,offset:0}, {opacity:1,offset:leg / budget},
      {opacity:1,offset:(leg + hold) / budget}, {opacity:0,offset:1}
    ] : [{opacity},{opacity:end}];
    const animation = animateSnapshot(track,keyframes,replace ? budget : leg);
    if (!animation) return;
    if (sameLive) paintTheme(track);
    if (replace) animation.ready.then(() => {
      if (!current()) return;
      track.timer = setTimeout(() => {
        track.timer = 0;
        if (!current()) return;
        track.frame = G.requestAnimationFrame(() => {
          track.frame = 0;
          if (current()) paintTheme(track);
        });
      },Math.max(0,leg + 8 - (Number(animation.currentTime) || 0)));
    },() => {});
    animation.finished.then(() => {if (current()) finishThemeFade(track,true);},() => {});
  }
  function crossFade(fn, {from, to, animate:animateTheme = true} = {}) {
    const doc = G.document, motion = G.AtriumMotionUI;
    const allowed = animateTheme && motion?.enabled() && typeof doc?.startViewTransition === "function";
    const active = themeFade;
    if (active) {
      active.target = to;
      active.apply = fn;
      if (!allowed || !active.effect) {
        finishThemeFade(active, true);
        return;
      }
      aimTheme(active);
      return;
    }
    if (!allowed || from === to) {
      fn();
      return;
    }
    const track = themeFade = {from, live:from, target:to, apply:fn, change:0};
    const root = doc.documentElement;
    root.setAttribute("data-theme-fading", "");
    try {
      track.transition = doc.startViewTransition(() => {
        if (themeFade !== track) return;
        // Only the outgoing snapshot is captured. The new editor stays live
        // in its DOM location so pointer hit testing reaches the workbench.
        root.setAttribute("data-theme-live","");
        paintTheme(track);
      });
    } catch {
      finishThemeFade(track, true);
      return;
    }
    track.unwatch = motion.whenDisabled(() => finishThemeFade(track, true));
    track.transition.ready.then(() => {
      if (themeFade === track) track.effect = doc.getAnimations().find(a => a.animationName === "atrium-theme-out");
    }, () => {});
    track.transition.finished.then(() => finishThemeFade(track),error => {
      finishThemeFade(track);
      G.console?.error?.(error);
    });
  }

  // ---------------------------------------------------------------- canvas effects
  let H = null, accent = G.AtriumTheme?.PRESETS.dark.tokens.accent || "currentColor", accentPending = false, doc$ = null;
  const MAX_BOXES = 400;
  // Effects: one slot per kind, so a new undo replaces the last undo pulse, and so on.
  const fx = {pulse: null, gone: null, settle: null, halo: null, fade: null};
  let fxCount = 0;
  function readAccent() {
    try { const v = G.getComputedStyle?.(G.document.documentElement)?.getPropertyValue("--accent")?.trim(); if (v) accent = v; } catch {}
  }
  function boxesOf(d, items) {
    const N = G.AtriumNavCommon, defs = H?.defs?.();
    if (!N?.itemBox || !d) return null;
    const n = Math.min(items.length, MAX_BOXES), out = new Float64Array(4 * Math.max(1, n));
    let k = 0, u = null;
    for (let i = 0; i < items.length; i++) {
      const b = N.itemBox(d, defs, items[i]);
      if (!b || !b.every(Number.isFinite)) continue;
      if (i < MAX_BOXES) { out[k++] = b[0]; out[k++] = b[1]; out[k++] = b[2]; out[k++] = b[3]; }
      else u = N.union(u, b);
    }
    if (u) { out[0] = Math.min(out[0], u[0]); out[1] = Math.min(out[1], u[1]); out[2] = Math.max(out[2], u[2]); out[3] = Math.max(out[3], u[3]); }
    return k ? {boxes: out, count: k / 4} : null;
  }
  // Keep the overlay frames coming while any effect lives; stop the moment the last one ends.
  // An effect whose document is not on screen never paints, so it also expires by the clock.
  function expire(t) {
    for (const k in fx) { const e = fx[k]; if (e && (e.start < 0 ? t - e.created > e.ms + 500 : t - e.start >= e.ms + 50)) end(k); }
  }
  function tickEffects() {
    if (!fxCount) return;
    if (!enabled()) {
      const preferenceOff = level(true) === "off";
      for (const kind in fx) if (preferenceOff || kind !== "pulse" && kind !== "gone") end(kind);
    }
    expire(now());
    H?.redrawOverlay?.();
  }
  function start(kind, e) {
    if (!fx[kind]) fxCount++;
    fx[kind] = e; e.start = -1; e.created = now();
    if (kind !== "fade") accentPending = true;
    schedule();
  }
  function end(kind) {
    if (!fx[kind]) return;
    fx[kind] = null; fxCount--;
    cancelIdleFrame();
  }
  const DASH = [0, 0], SOLID = [];
  const progress = (e, t) => { if (e.start < 0) e.start = t; return e.ms > 0 ? Math.min(1, (t - e.start) / e.ms) : 1; };

  // Undo applies synchronously. Optional outlines use the objects already named by the replay.
  function undone(d, replayedItems) {
    const changed = H && !hidden() && level(true) !== "off" ? replayedItems?.(d, MAX_BOXES) : null;
    if (!changed) { end("pulse"); end("gone"); return; }
    doc$ = d.id;
    const now$ = boxesOf(d, changed.changed), gone = boxesOf(d, changed.removed);
    if (now$) start("pulse", {...now$, ms:DURATIONS.base}); else end("pulse");
    if (gone) start("gone", {...gone, ms:DURATIONS.base}); else end("gone");
  }
  function settle(d, items) {
    const s = boxesOf(d, items);
    if (!s) return;
    doc$ = d.id;
    start("settle", {...s, ms: duration("base"), move: moves()});
  }
  function halo(d, items) {
    const s = boxesOf(d, items);
    if (!s) return;
    doc$ = d.id;
    start("halo", {...s, ms: duration("fast"), move: moves()});
  }

  // Cross-fade: copy what the canvas shows now; the next frames draw the copy over the new picture
  // with falling opacity. One copy canvas, reused (resized only when the canvas size changes).
  let snap = null, snapCtx = null;
  function reveal(ms = duration("fast"), {follow = false} = {}) {
    if (!H || hidden() || !enabled() || ms <= 0) return false;
    if (H.drag?.() || H.liveRoute?.()) return false;          // never ghost what the hand is moving
    const c = H.canvas?.(), d = H.doc?.();
    if (!c || !c.width || !c.height || !d || !G.document?.createElement) return false;
    if (fx.fade && fx.fade.start < 0 && fx.fade.canvas === c) { fx.fade.ms = Math.max(fx.fade.ms, ms); return true; }  // already holding the old frame
    if (!snap) { snap = G.document.createElement("canvas"); snapCtx = snap.getContext("2d"); }
    if (!snapCtx) return false;
    if (snap.width !== c.width || snap.height !== c.height) { snap.width = c.width; snap.height = c.height; }
    else snapCtx.clearRect(0, 0, snap.width, snap.height);
    try { snapCtx.drawImage(c, 0, 0); } catch { return false; }
    const cam = H.view?.()?.camera?.();
    start("fade", {canvas: c, w: c.width, h: c.height, ms, follow, cx: cam?.cx, cy: cam?.cy, scale: cam?.scale});
    return true;
  }
  const cancelFade = () => { if (fx.fade) { end("fade"); H?.redrawOverlay?.(); } };

  function strokeBoxes(ctx, e, pad, px) {
    const b = e.boxes;
    for (let i = 0; i < e.count; i++) {
      const o = 4 * i;
      ctx.rect(b[o] - pad, b[o + 1] - pad, b[o + 2] - b[o] + 2 * pad, b[o + 3] - b[o + 1] + 2 * pad);
    }
    ctx.lineWidth = 1.5 * px;
  }
  function paint(ctx, env) {
    const t = now(), px = 1 / (env.scale || 1);
    ctx.save();
    // Cross-fade first: effects draw over the new picture, not under the old one.
    const f = fx.fade;
    if (f) {
      const p = progress(f, t), cam = H.view?.()?.camera?.();
      const moved = !f.follow && cam && (cam.cx !== f.cx || cam.cy !== f.cy || cam.scale !== f.scale);
      if (p >= 1 || moved || f.canvas !== H.canvas?.() || f.canvas.width !== f.w || f.canvas.height !== f.h) end("fade");
      else {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1 - ease("standard")(p);
        ctx.drawImage(snap, 0, 0);
        ctx.restore();
      }
    }
    if (accentPending) { readAccent(); accentPending = false; }
    ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineJoin = "round";
    // Undo and redo fade the outline without moving the changed objects.
    const u = fx.pulse;
    if (u) {
      const p = progress(u, t);
      if (p >= 1) end("pulse");
      else {
        ctx.beginPath(); strokeBoxes(ctx, u, 2 * px, px);
        ctx.globalAlpha = .16 * (1 - p); ctx.fill();
        ctx.globalAlpha = .95 * (1 - p * p); ctx.stroke();
      }
    }
    const g = fx.gone;
    if (g) {
      const p = progress(g, t);
      if (p >= 1) end("gone");
      else {
        ctx.beginPath(); strokeBoxes(ctx, g, 2 * px, px);
        DASH[0] = 4 * px; DASH[1] = 3 * px;
        ctx.setLineDash(DASH); ctx.globalAlpha = .8 * (1 - ease("standard")(p)); ctx.stroke(); ctx.setLineDash(SOLID);
      }
    }
    // Placement: a ring that springs onto the part as it lands.
    const s = fx.settle;
    if (s) {
      const p = progress(s, t);
      if (p >= 1) end("settle");
      else {
        const e = ease("decelerate")(p), pad = (1 + (s.move && moves() ? 8 * (1 - e) : 0)) * px;
        ctx.beginPath(); strokeBoxes(ctx, s, pad, px);
        ctx.globalAlpha = .9 * (1 - ease("accelerate")(p)); ctx.stroke();
      }
    }
    // Selection: a quick halo outside the selection outline.
    const h = fx.halo;
    if (h) {
      const p = progress(h, t);
      if (p >= 1) end("halo");
      else {
        const e = ease("decelerate")(p), pad = (3 + (h.move ? 3 * (1 - e) : 0)) * px;
        ctx.beginPath(); strokeBoxes(ctx, h, pad, px);
        ctx.globalAlpha = .55 * (1 - p); ctx.stroke();
      }
    }
    ctx.restore();
  }
  const OVERLAY = Object.freeze({overlay: paint});

  // Actions that change the picture wholesale cross-fade (editor.js act() calls action(a) first).
  const REVEAL = new Map([
    ["flip-board", "base"], ["toggle-unrouted", "fast"], ["drc", "base"], ["drc-clear", "fast"], ["repour", "base"],
  ]);
  function action(a) { const k = REVEAL.get(a); if (k && H) reveal(duration(k)); }

  // Watching the editor: placement and big commits.
  let lastDoc = null, lastItems = null, lastLen = 0, lastPours = null;
  function sync(d) { lastDoc = d?.id ?? null; lastItems = d?.items || null; lastLen = lastItems?.length || 0; lastPours = d?.pcbDrawing?.pours ?? null; }
  // Live pours (polygon-pour.js) show changed copper as tile patches before its exact fill commits.
  // That commit then changes no pixels worth a cross-fade (a whole-board repaint every frame).
  function tilesShown(d) {
    for (const pt of G.AtriumPolygonPour?.tiles?.patches?.values?.() || []) if (pt.doc === d && pt.shown?.size) return true;
    return false;
  }
  function onChange(info) {
    const d = H.doc?.();
    if (info?.source === "undo") { cancelFade(); end("settle"); sync(d); return; }
    if (!d || level() === "off") { sync(d); return; }
    // An edit supersedes a cross-fade in flight: its snapshot shows the board before the edit.
    if (fx.fade && fx.fade.start >= 0 && info?.source !== "pours") cancelFade();
    const items = d.items, pours = d.pcbDrawing?.pours ?? null;
    if (d.id === lastDoc && items) {
      if (items === lastItems && items.length > lastLen) {
        const added = items.slice(lastLen), parts = added.filter(i => i.kind === "part");
        if (parts.length && parts.length <= 64) settle(d, parts);
        else if (added.length >= 16) reveal(duration("base"));
      } else if (items !== lastItems && Math.abs(items.length - lastLen) >= 16) reveal(duration("base"));
      // repour, live pours (a Repour All that animates its reveals, pour-anim.js, commits without one)
      else if (pours !== lastPours && lastPours && !G.AtriumPourAnim?.active?.(d) && !(info?.source === "pours" && tilesShown(d))) reveal(duration("base"));
    }
    sync(d);
  }
  function attach(host) {
    if (H || !host?.addRenderer) return;
    H = host;
    host.addRenderer((d, info) => fxCount && info?.active && (fx.fade || d?.id === doc$) ? OVERLAY : null);
    host.on?.("change", onChange);
    host.on?.("document", () => {
      cancelFade(); end("pulse"); end("gone"); end("settle"); end("halo"); sync(host.doc?.());
    });
    sync(host.doc?.());
    const D = G.document;
    if (D?.addEventListener) {
      // A new gesture cancels a cross-fade in flight (it would ghost under the pointer).
      for (const t of ["pointerdown", "wheel", "keydown"]) D.addEventListener(t, () => { if (fx.fade) cancelFade(); }, {capture: true, passive: true});
    }
  }
  if (G.AtriumNavCommon?.ready) G.AtriumNavCommon.ready(attach);
  else if (G.AtriumNavHost) attach(G.AtriumNavHost);
  G.document?.addEventListener?.("visibilitychange",syncStyleVisibility);
  G.AtriumPower?.onChange?.(syncStyleVisibility);
  syncStyleVisibility();

  return Object.freeze({DURATIONS, PRESETS, EASES, level, moves, enabled, duration, ease, cssEase, bezier, describePolicy, plan, sample, retarget, animate, choreograph, placeBox,
    butterEnabled, syncPolicy, afterVisible, active, crossFade,
    get ui() { return G.AtriumMotionUI; },
    undone, action, reveal, attach, _fx: fx});
})();
