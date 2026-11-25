"use strict";
// AtriumCamera: mouse preferences and RTS-style camera controls for the 2D editors (lazy; loaded when
// the editor is first idle, or by any of its actions).
//
//   Wheel presets (Preferences › Mouse and Camera, "mouse.wheel"):
//     zoom    Waffle: a notched wheel zooms at the pointer, Shift+wheel scrolls sideways, pixel
//             scrolling (trackpads, high-resolution wheels) pans.
//     altium  Altium: the wheel scrolls vertically, Shift+wheel sideways, Ctrl/⌘+wheel zooms.
//   In both, Ctrl/⌘+wheel and trackpad pinch zoom, and horizontal deltas (tilt wheels, thumb side
//   wheels) pan sideways. Zoom speed, direction and anchor (pointer or centre) are preferences.
//   The right-button drag pan and the back/forward thumb buttons are thin hooks in editor.js.
//
//   Camera: view history per document (Alt+←/→, thumb buttons), saved views (J 1…9 recall,
//   J M 1…9 save; kept per document in this browser), jump to the last alert (J E: the newest
//   DRC/ERC message or the last edit), arrow-key pan when idle (Shift: faster), WASD and edge
//   scrolling with the opt-in "Altium + RTS camera" key preset, and an ease-out fly-to (about 180 ms)
//   that respects reduced motion and the "camera.animate" preference.
//
// Pure helpers (wheelAction, History, ease, significant) run headless; tests/camera.cjs covers them.
globalThis.AtriumCamera = (() => {
  const DEFAULTS = Object.freeze({
    "mouse.wheel": "zoom", "mouse.zoomSpeed": 1, "mouse.invertZoom": false, "mouse.zoomAt": "pointer",
    "camera.animate": true, "camera.momentum": true, "camera.rotate": false, "camera.panSpeed": 1, "camera.edgeScroll": "auto", "camera.minimap": false
  });
  const CHOICES = {"mouse.wheel": ["zoom", "altium"], "mouse.zoomAt": ["pointer", "centre"], "camera.edgeScroll": ["auto", "on", "off"]};
  const RANGES = {"mouse.zoomSpeed": [.25, 3], "camera.panSpeed": [.5, 3]};
  const cfg = {...DEFAULTS};
  function clean(key, v) {
    const d = DEFAULTS[key];
    if (typeof d === "boolean") return v === true || v === "true";
    if (typeof d === "number") { const n = Number(v), [lo, hi] = RANGES[key]; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
    return CHOICES[key]?.includes(v) ? v : d;
  }
  function reload() {
    const P = globalThis.AtriumPref;
    for (const k of Object.keys(DEFAULTS)) { let v; try { v = P?.get?.(k, DEFAULTS[k]); } catch {} cfg[k] = clean(k, v ?? DEFAULTS[k]); }
  }
  let subscribed = false;
  function subscribe() {
    const P = globalThis.AtriumPrefs;
    if (subscribed || !P?.on) return;
    subscribed = true; P.on("mouse.", reload); P.on("camera.", () => { reload(); edgeSync(); });
  }
  function setPref(key, value) {
    value = clean(key, value);
    try { globalThis.AtriumPref?.set?.(key, value); } catch {}
    cfg[key] = value; subscribe(); edgeSync();
    return value;
  }
  reload();

  // ---------------------------------------------------------------- wheel
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const hasWheelDelta = e => !!(e.deltaX || e.deltaY);
  const nativeWheelSteps = e => e.isTrusted && globalThis.__waffleWheelNotches?.(e);
  const wheelHasMotion = e => hasWheelDelta(e) || !!nativeWheelSteps(e)?.length;
  function wheelDetent(e) {
    const mode = e.deltaMode, dy = e.deltaY, legacy = e.wheelDeltaY;
    if (mode === 1 || mode === 2) return true;
    if (e.deltaX) return false;
    if (e.isTrusted && globalThis.__waffleIsWheelNotch) return globalThis.__waffleIsWheelNotch(e);
    if (!dy) return false;
    // Pixel-mode notches can still carry the legacy ±120 count. A trackpad often reports −3 × deltaY.
    if (Number.isFinite(legacy) && legacy !== 0) return legacy % 120 === 0 && legacy !== -3 * dy;
    // Keep the existing unmodified wheel convention where no device clue is delivered.
    // Chromium may deliver whole-pixel Ctrl+wheel pinch updates, so size alone cannot identify them.
    return !e.ctrlKey && Math.abs(dy) >= 80 && Number.isInteger(dy) && dy % 40 === 0;
  }
  const wheelPinch = (e, detent = wheelDetent(e)) => hasWheelDelta(e) && !!e.ctrlKey && !e.metaKey && !detent;
  function bundledDetents(e, detent) {
    const legacy = e.wheelDeltaY;
    // Chromium can merge same-direction Windows notches. Each detent in this
    // packet shape contributes 100 CSS pixels and 120 legacy units.
    if (detent && e.isTrusted && !globalThis.__waffleIsWheelNotch && e.ctrlKey && !e.metaKey &&
        e.deltaMode === 0 && !e.deltaX && Number.isSafeInteger(legacy) && Math.abs(legacy) > 120 &&
        legacy % 120 === 0 && e.deltaY * 6 === -legacy * 5) return Math.abs(legacy / 120);
    return 1;
  }
  // What one wheel event does: {zoom, at:"pointer"|"centre"} or {pan:[dx, dy]} in canvas pixels.
  function wheelAction(e, c = cfg, page = 800, detent = wheelDetent(e)) {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page : 1;
    const dx = (e.deltaX || 0) * unit, dy = (e.deltaY || 0) * unit, mod = !!(e.ctrlKey || e.metaKey);
    const pinch = wheelPinch(e, detent);
    if (!mod && dx && !dy) return {pan: [-dx, 0]};                        // tilt and thumb side wheels
    if (mod || c["mouse.wheel"] === "zoom" && detent && !e.shiftKey) {
      const count = bundledDetents(e, detent);
      let d = clamp((dy || dx) / count, -120, 120) * count * .008;
      if (!pinch) { d *= c["mouse.zoomSpeed"]; if (c["mouse.invertZoom"]) d = -d; }
      return {zoom: Math.exp(-d), at: pinch || c["mouse.zoomAt"] !== "centre" ? "pointer" : "centre"};
    }
    if (e.shiftKey && !dx) return {pan: [-dy, 0]};
    return {pan: [-dx, -dy]};
  }
  let wheelMotion = null, wheelInterrupted = -Infinity;
  const viewWheelInterrupted = new WeakMap();
  function clearWheelFrame(view) {
    if (!wheelMotion || view && wheelMotion.view !== view) return;
    const motion = wheelMotion;
    wheelMotion = null;
    motion.track?.cancel();
  }
  function stopWheel(view) {
    const now = performance.now();
    if (view) viewWheelInterrupted.set(view, now);
    else wheelInterrupted = now;
    clearWheelFrame(view);
  }
  function notchZoom(view, canvas, zoom, at, redraw, eventStamp) {
    const from = view.camera();
    const prior = wheelMotion?.view === view && same(from, wheelMotion.last) ? wheelMotion : null;
    const target = view.zoomScale((prior?.target ?? from.scale) * zoom);
    const traceStamp = prior?.traceStamp ?? eventStamp;
    clearWheelFrame();
    if (target === from.scale) return;
    const motion = wheelMotion = {view, target, last: from, traceStamp};
    function step(progress, t) {
      if (wheelMotion !== motion) return;
      const current = view.camera();
      if (canvas.isConnected === false || current.flipped !== motion.last.flipped || !same(current, motion.last)) { stopWheel(); return; }
      if (!animate()) t = 1;
      const scale = t === 1 ? target : from.scale * Math.pow(target / from.scale, progress);
      if (scale !== current.scale) {
        view.zoom(scale / current.scale, at);
        motion.last = view.camera();
      }
      if (t === 1) clearWheelFrame();
      if (scale !== current.scale) {
        if (motion.traceStamp != null) {
          globalThis.__waffleFrameTrace?.wheel?.(canvas, motion.traceStamp);
          motion.traceStamp = null;
        }
        redraw(!!motion.track);
      }
    }
    motion.track = globalThis.AtriumMotion.animate({ms:120,ease:"decelerate",camera:true,fromInput:true,step});
  }
  function wheel(e, view, s, canvas, redraw, action = wheelAction) {
    subscribe();
    const steps = nativeWheelSteps(e);
    if (steps?.length > 1) {
      // A native packet can include opposing detents. Keep each step's sign, clamp and cutoff.
      for (const step of steps) wheelStep({...step, isTrusted:true, deltaMode:0, deltaX:0,
        ctrlKey:e.ctrlKey, metaKey:e.metaKey, shiftKey:e.shiftKey, altKey:e.altKey}, view, s, canvas, redraw, action, true);
      return true;
    }
    // A coalesced packet may cancel to zero without conveying either step.
    // There is no camera input to apply and no reason to interrupt a glide.
    if (!hasWheelDelta(e) && !steps?.length) return true;
    return wheelStep(e, view, s, canvas, redraw, action, steps?.length === 1 || wheelDetent(e));
  }
  function wheelStep(e, view, s, canvas, redraw, action, detent) {
    // macOS forwards a marked notch to WebKit after delivering its classification. A newer focus
    // or tool change wins if it happened before the deferred DOM event reached this view.
    if (detent && e.isTrusted && globalThis.__waffleIsWheelNotch &&
        e.timeStamp < Math.max(wheelInterrupted, viewWheelInterrupted.get(view) ?? -Infinity)) return true;
    const a = action(e, cfg, canvas?.clientHeight || 800, detent);
    const glide = detent && a.zoom && redraw && view.zoomScale && globalThis.AtriumMotion?.animate && animate();
    // A direct wheel update cancels the old glide and preserves the remaining queued wheel events.
    if (!glide) clearWheelFrame(view);
    takeCamera(view, true);
    if (a.zoom) {
      const at = a.at === "centre" ? [(canvas?.clientWidth || 0) / 2, (canvas?.clientHeight || 0) / 2] : s;
      const eventStamp = globalThis.__waffleFrameTrace && e.isTrusted && e.ctrlKey && !wheelPinch(e, detent) ? e.timeStamp : null;
      if (glide) { notchZoom(view, canvas, a.zoom, at, redraw, eventStamp); return true; }
      const scale = eventStamp == null ? null : view.camera().scale;
      view.zoom(a.zoom, at);
      if (scale != null && scale !== view.camera().scale && redraw) globalThis.__waffleFrameTrace?.wheel?.(canvas, eventStamp);
    } else view.pan(a.pan[0], a.pan[1]);
    redraw?.();
    return true;
  }

  // Preview's original canvas input. Pen stays on the ordinary editor tool path.
  function basicInput({frame, busy}) {
    let states = new WeakMap();
    const owners = new Map();
    function state(pane) {
      if (!states.has(pane)) states.set(pane, {points:new Map(), lastTouch:-Infinity, gesture:null});
      return states.get(pane);
    }
    function screen(e, c) {
      const b = c.getBoundingClientRect();
      return [e.clientX-b.left, e.clientY-b.top];
    }
    function fingers(points) {
      const it = points.values(), a = it.next().value, b = it.next().value;
      return b ? {at:[(a[0]+b[0])/2,(a[1]+b[1])/2], span:Math.hypot(a[0]-b[0],a[1]-b[1])} : {at:a, span:0};
    }
    function move(pane, from, to, factor) {
      if (from[0] === to[0] && from[1] === to[1] && factor === 1) return;
      pane.view.pan(to[0]-from[0],to[1]-from[1]);
      if (factor !== 1) pane.view.zoom(factor,to);
      frame(pane);
    }
    function handle(e, pane) {
      pane = owners.get(e.pointerId) || pane;
      if (!pane?.view) return false;
      if (e.type === "pointerdown") stopWheel();
      const s = state(pane), c = pane.canvas;
      if (e.type === "wheel") {
        if (!s.gesture && !s.points.size) wheel(e,pane.view,screen(e,c),c,()=>frame(pane));
        return true;
      }
      if (e.type.startsWith("gesture")) {
        const g = s.gesture, at = Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ?
          screen(e,c) : g?.at || [c.clientWidth/2,c.clientHeight/2];
        if (e.type === "gesturestart") {
          s.gesture = {at,scale:e.scale>0?e.scale:1,direct:!!s.points.size};
          takeCamera(pane.view);
        } else if (e.type === "gestureend") s.gesture = null;
        else if (g && !g.direct && e.scale > 0 && Number.isFinite(e.scale)) {
          move(pane,g.at,at,e.scale/g.scale); g.at=at; g.scale=e.scale;
        }
        return true;
      }
      if (["click","dblclick","auxclick","contextmenu"].includes(e.type))
        return e.pointerType === "touch" || !!s.points.size || performance.now()-s.lastTouch < 700;
      if (e.type === "pointerdown" && e.pointerType === "mouse") s.lastTouch = -Infinity;
      if (e.pointerType !== "touch") return false;
      if (e.type === "pointerdown") {
        if (!busy()) {
          takeCamera(pane.view);
          s.points.set(e.pointerId,screen(e,c)); owners.set(e.pointerId,pane);
          if (s.gesture) s.gesture.direct = true;
          try { c.setPointerCapture(e.pointerId); } catch {}
        }
      } else if (s.points.has(e.pointerId)) {
        if (e.type === "pointermove" || e.type === "pointerup") {
          const from=fingers(s.points);
          s.points.set(e.pointerId,screen(e,c));
          const to=fingers(s.points);
          move(pane,from.at,to.at,from.span&&to.span?to.span/from.span:1);
        }
        if (e.type !== "pointermove") {
          s.points.delete(e.pointerId); owners.delete(e.pointerId); s.lastTouch=performance.now();
        }
      }
      return true;
    }
    return {handle, clear() {stopWheel(); states = new WeakMap(); owners.clear();},
      prune() {for (const [id,pane] of owners) if (!pane.canvas.isConnected) owners.delete(id);}};
  }

  // ---------------------------------------------------------------- motion
  const ease = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);              // ease-out cubic
  function animate() {
    if (!cfg["camera.animate"] || typeof requestAnimationFrame !== "function") return false;
    if (globalThis.AtriumMotionUI) return globalThis.AtriumMotionUI.moves();
    const m = globalThis.document?.documentElement?.getAttribute?.("data-motion");
    if (m === "reduce" || m === "off") return false;
    try {
      return !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches &&
        (globalThis.AtriumMotion?.moves() ?? true);
    } catch { return true; }
  }
  // Interpolate a camera: centre linearly, scale geometrically.
  // Writes into one reused object (a flight frame allocates nothing): restoreCamera() copies it at once.
  const mixed = {};
  function mix(a, b, t) {
    for (const k in b) mixed[k] = b[k];
    const angle=(b.rotation||0)-(a.rotation||0); mixed.rotation=(a.rotation||0)+Math.atan2(Math.sin(angle),Math.cos(angle))*t;
    mixed.cx = a.cx + (b.cx - a.cx) * t; mixed.cy = a.cy + (b.cy - a.cy) * t; mixed.scale = a.scale * Math.pow(b.scale / a.scale, t);
    return mixed;
  }
  const host = () => globalThis.AtriumNavHost;
  const nudgeFrame = v => { host()?.redraw?.(); v?.moving?.(); };
  let fly = null;
  function stopFly(view) {
    if (!fly || view && fly.view !== view) return;
    const motion = fly;
    fly = null;
    motion.track?.cancel();
  }
  // Finish a flight now (the camera jumps to its target).
  function land() { const f = fly; if (!f) return; stopFly(); f.view.restoreCamera(f.target); }
  // editor.js: run an instant camera change f() (Fit, Zoom, a jump) as a flight to where it leaves the view.
  function glideTo(view, f, {relative = false} = {}) {
    const from = view.camera(), prior = relative && fly?.view === view && animate() ? fly.target : null;
    stopFly();
    let target;
    try { if (prior) view.restoreCamera(prior); f(); target = view.camera(); }
    finally { view.restoreCamera(from); }
    flyTo(target, {view});
  }
  // Flight time: --motion-base, or --motion-slow for a big move (over 4× zoom or a screen away).
  function flightMs(a, b, canvas = host()?.canvas?.()) {
    const w = Math.max(canvas?.clientWidth || 800, canvas?.clientHeight || 600);
    const far = Math.abs(Math.log(b.scale / a.scale)) > Math.log(4) || Math.hypot(b.cx - a.cx, b.cy - a.cy) * Math.min(a.scale, b.scale) > w;
    return globalThis.AtriumMotion?.duration(far ? "slow" : "base") ?? (far ? 320 : 200);
  }
  // Move the active view to `to` (a camera: cx, cy, scale), animated unless motion is reduced.
  function flyTo(to, {ms, view = host()?.view?.(), canvas, redraw = () => host()?.redraw?.()} = {}) {
    if (!view || !to) return;
    stopWheel();
    globalThis.AtriumCanvasInput?.stopMotion(view);
    globalThis.AtriumSplitFollow?.cancelGlide?.(view);
    const from = view.camera(), target = {...from, ...to, scale: to.scale || from.scale};
    if (same(from, target) && !from.flipped === !target.flipped) { stopFly(); stopGlide(); return; }   // already there
    ms ??= flightMs(from, target, canvas);
    const motion = globalThis.AtriumMotion;
    stopFly(); stopGlide();
    if (!motion?.animate || !animate() || ms <= 0) { view.restoreCamera(target); redraw(); return; }
    const flight = fly = {view, last: from, target};
    function step(progress, t) {
      if (fly !== flight) return;
      if (!same(view.camera(), flight.last)) { stopFly(); return; }
      if (!animate()) t = 1;
      if (!t) return;
      view.restoreCamera(t === 1 ? target : mix(from, target, progress));
      flight.last = view.camera();
      if (t === 1) stopFly();
      redraw();
      if (t < 1) view.moving?.();
    }
    flight.track = motion.animate({ms, ease:"standard", camera:true, fromInput:true, step});
  }
  const same = (a, b) => Math.abs(a.cx - b.cx) < 1e-9 && Math.abs(a.cy - b.cy) < 1e-9 && Math.abs(a.scale - b.scale) < 1e-12 && Math.abs((a.rotation||0)-(b.rotation||0))<1e-9;

  // Retarget from the displayed position while retaining the remainder of an accumulated pan.
  let glide = null;
  function stopGlide() { if (glide) { glide.track?.cancel(); glide = null; } }
  function takeCamera(view, keepWheel) {
    if (!keepWheel) stopWheel(view);
    globalThis.AtriumCanvasInput?.stopMotion(view);
    globalThis.AtriumSplitFollow?.cancelGlide?.(view);
    stopFly(view);
    if (glide?.view === view) stopGlide();
    edgeStop();
  }
  function panBy(dx, dy) {
    const H = host(), view = H?.view?.();
    if (!view) return;
    if (glide?.view === view) { dx += glide.x; dy += glide.y; }
    takeCamera(view);
    stopGlide();
    const motion = globalThis.AtriumMotion;
    if (!animate() || !motion?.choreograph) { view.pan(dx,dy); nudgeFrame(view); return; }
    const pending = glide = {view,x:dx,y:dy};
    pending.track = motion.choreograph(view,"camera",{camera:true,ease:"decelerate",
      step(e) {
        const remainingX = dx * (1 - e), remainingY = dy * (1 - e);
        view.pan(pending.x - remainingX,pending.y - remainingY);
        pending.x = remainingX; pending.y = remainingY; nudgeFrame(view);
      }, done() { if (glide === pending) glide = null; }});
  }
  const DIR = {left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1]};
  function panKey(d, fast) {
    const c = host()?.canvas?.(), w = c?.clientWidth || 800, h = c?.clientHeight || 600;
    const step = Math.min(w, h) * .12 * cfg["camera.panSpeed"] * (fast ? 3.5 : 1);
    panBy(DIR[d][0] * step, DIR[d][1] * step);
  }

  // ---------------------------------------------------------------- history
  // Views that differ by a pan of a third of the screen or a zoom of 1.4× are separate steps; smaller
  // moves update the current step. `size` is the canvas [w, h] in pixels.
  function significant(a, b, size = [800, 600]) {
    if (!a || !b) return true;
    if (a.docId !== b.docId) return true;
    const r = Math.max(a.scale, b.scale) / Math.max(1e-12, Math.min(a.scale, b.scale));
    if (r > 1.4) return true;
    const s = Math.min(a.scale, b.scale);
    const rotation=(a.rotation||0)-(b.rotation||0);
    return Math.abs(a.cx-b.cx)*s>size[0]/3 || Math.abs(a.cy-b.cy)*s>size[1]/3 || Math.abs(Math.atan2(Math.sin(rotation),Math.cos(rotation)))>Math.PI/6;
  }
  class History {
    constructor(limit = 50) { this.list = []; this.i = -1; this.limit = limit; }
    note(cam, size) {
      const cur = this.list[this.i];
      if (cur && !significant(cur, cam, size)) { this.list[this.i] = cam; return false; }
      this.list.length = this.i + 1; this.list.push(cam);
      if (this.list.length > this.limit) this.list.shift();
      this.i = this.list.length - 1; return true;
    }
    back() { if (this.i <= 0) return null; return this.list[--this.i]; }
    forward() { if (this.i >= this.list.length - 1) return null; return this.list[++this.i]; }
    get canBack() { return this.i > 0; }
    get canForward() { return this.i < this.list.length - 1; }
  }
  const histories = new Map();
  const historyFor = id => { let h = histories.get(id); if (!h) histories.set(id, h = new History()); return h; };
  let settleTimer = 0, seen = null, itinerary = null, navigating = false;
  const viewSize = () => { const c = host()?.canvas?.(); return [c?.clientWidth || 800, c?.clientHeight || 600]; };
  // Called on each active render: the camera is noted once it has rested for 450 ms.
  function observe() {
    const H = host(), v = H?.view?.(); if (!v) return;
    const cam = v.camera();
    if (seen && same(seen.cam, cam) && seen.doc === H.currentId()) return;
    seen = {cam, doc: H.currentId()};
    clearTimeout(settleTimer); settleTimer = setTimeout(settle, 450);
  }
  function settle() {
    clearTimeout(settleTimer); settleTimer = 0;
    const H = host(), v = H?.view?.(); if (!v || fly) return;
    historyFor(H.currentId()).note(strip(v.camera()), viewSize());
    if (itinerary) itinerary.note(location(H, v.camera()), viewSize());
    onMoved();
  }
  const strip = c => ({cx: c.cx, cy: c.cy, scale: c.scale});
  const location = (H, cam) => ({...strip(cam), docId:H.currentId(), selection:H.selection(),
    occurrence:globalThis.AtriumConnectionPreview?.location?.()});
  // Stay in the current document's ordinary view history until an explicit
  // cross-document jump. Back/Forward can then retrace sheets and cameras together.
  function jump(docId, move) {
    const H = host();
    if (!H?.docById(docId)) return false;
    land(); settle();
    if (!itinerary) {
      const prior = historyFor(H.currentId());
      itinerary = new History();
      itinerary.list = prior.list.slice(0, prior.i + 1).map(cam => ({...cam, docId:H.currentId()}));
      itinerary.i = itinerary.list.length - 1;
    }
    itinerary.note(location(H, H.view().camera()), viewSize());
    navigating = true;
    try { if (H.currentId() !== docId) H.selectDocument(docId); move(); }
    finally { navigating = false; }
    itinerary.note(location(H, fly?.target || H.view().camera()), viewSize());
    return true;
  }
  function step(dir) {
    const H = host(); if (!H?.view) return;
    land(); settle();
    const h = itinerary || historyFor(H.currentId()), cam = dir < 0 ? h.back() : h.forward();
    if (!cam) { H.info?.(dir < 0 ? "No previous view." : "No next view."); return; }
    if (cam.docId) {
      navigating = true;
      try {
        if (cam.docId !== H.currentId() && H.docById(cam.docId)) H.selectDocument(cam.docId);
        globalThis.AtriumConnectionPreview?.restoreLocation?.(cam.occurrence);
        if (cam.selection) H.select(cam.selection);
      } finally { navigating = false; }
    }
    flyTo(strip(cam));
    H.info?.((dir < 0 ? "Previous view" : "Next view") + " (" + (h.i + 1) + " of " + h.list.length + ").");
  }

  // ---------------------------------------------------------------- saved views
  const VIEWS = "atrium.camera.views.v1";
  function readViews() { try { const o = JSON.parse(globalThis.localStorage?.getItem(VIEWS) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
  function writeViews(o) { try { globalThis.localStorage?.setItem(VIEWS, JSON.stringify(o)); } catch {} }
  const finite = c => c && [c.cx, c.cy, c.scale].every(Number.isFinite) && c.scale > 0;
  function storeView(n) {
    const H = host(), v = H?.view?.(); if (!v) return;
    const all = readViews(), id = H.currentId(), mine = all[id] && typeof all[id] === "object" ? all[id] : {};
    mine[n] = strip(v.camera()); all[id] = mine;
    // Keep the store small: at most 64 documents, the most recently saved last.
    const ids = Object.keys(all); if (ids.length > 64) for (const k of ids.slice(0, ids.length - 64)) delete all[k];
    delete all[id]; all[id] = mine; writeViews(all);
    H.info?.("Saved view " + n + ". J, " + n + " comes back to it.");
  }
  function recallView(n) {
    const H = host(); if (!H?.view) return;
    const cam = readViews()[H.currentId()]?.[n];
    if (!finite(cam)) { H.info?.("No saved view " + n + " on this document. " + keyText("camera-store-" + n, "J, M, " + n) + " saves the current view."); return; }
    settle(); flyTo(cam); H.info?.("Saved view " + n + ".");
  }
  function keyText(id, fallback) { try { return globalThis.AtriumKeymap?.hintFor?.(id, host()?.doc?.()?.kind) || fallback; } catch { return fallback; } }

  // ---------------------------------------------------------------- last alert
  // The newest DRC/ERC message with a place, or the last edit, whichever came later.
  let lastEdit = null;
  function noteEdit() {
    const H = host(); if (!H?.doc) return;
    const d = H.doc(), sel = new Set(H.selection?.() || []), C = globalThis.AtriumNavCommon;
    let box = null;
    if (sel.size && C?.itemBox) for (const i of d.items) if (sel.has(i.id)) { const b = C.itemBox(d, H.defs(), i); if (b) box = box ? C.union(box, b) : b; }
    const p = H.pointer?.();
    if (!box && p) box = [p[0], p[1], p[0], p[1]];
    if (box) lastEdit = {doc: d.id, box, time: Date.now()};
  }
  function alertTarget() {
    const H = host(), list = globalThis.AtriumMessages?.messages?.() || [];
    let best = null;
    for (const m of list) {
      if (m.class === "Info" || !(m.point || m.objectId)) continue;
      const t = m.time?.getTime?.() || 0;
      if (!best || t >= best.time) best = {message: m, time: t};
    }
    if (lastEdit && (!best || lastEdit.time > best.time)) return {kind: "edit", doc: lastEdit.doc, box: lastEdit.box};
    if (!best) return null;
    const m = best.message, project = H?.project?.();
    const owner = m.documentId || project?.documents?.find(d => d.items?.some?.(i => i.id === m.objectId))?.id || H?.currentId?.();
    const d = project?.documents?.find(x => x.id === owner), item = m.objectId && d?.items?.find(i => i.id === m.objectId);
    const box = item && globalThis.AtriumNavCommon?.itemBox?.(d, H.defs(), item) || (m.point ? [m.point[0], m.point[1], m.point[0], m.point[1]] : null);
    return box ? {kind: "message", doc: owner, box, message: m} : null;
  }
  function jumpAlert() {
    const H = host(); if (!H?.view) return;
    const t = alertTarget();
    if (!t) { H.info?.("No alerts yet. Run a design rule check (T, D) or validate the project (C, C)."); return; }
    if (t.doc && t.doc !== H.currentId() && H.docById?.(t.doc)) H.selectDocument(t.doc);
    settle();
    const v = H.view(), c = H.canvas(), cam = v.camera();
    const box = t.box, small = box[2] - box[0] < 1e-6 && box[3] - box[1] < 1e-6;
    const to = small ? {cx: box[0], cy: box[1], scale: Math.max(cam.scale, (cam.referenceScale || cam.scale) * 4)}
      : globalThis.AtriumNavCommon.cameraFor(box, c.clientWidth || 800, c.clientHeight || 600, cam, {margin: .5, maxFactor: 16});
    flyTo(to);
    H.info?.(t.kind === "edit" ? "Last edit." : "Last alert: " + t.message.class + " · " + t.message.text);
  }

  // ---------------------------------------------------------------- edge scrolling
  // With the RTS preset (or "camera.edgeScroll" on), resting the pointer within 12 px of a canvas edge
  // scrolls the view that way after 150 ms; speed grows towards the edge. No button may be held.
  const EDGE = 12;
  let edge = null, edgeOn = false;
  const edgeWanted = () => cfg["camera.edgeScroll"] === "on" || cfg["camera.edgeScroll"] === "auto" && globalThis.AtriumKeymap?.preset?.() === "rts";
  const edgeAllowed = () => edgeWanted() && !globalThis.AtriumPower?.idle?.();
  function edgeMove(e) {
    const H = host(), c = H?.canvas?.(), view = H?.view?.();
    if (!edgeAllowed() || !c || !view || e.target !== c || e.buttons || e.pointerType === "touch") { edgeStop(); return; }
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const fx = x < EDGE ? (EDGE - x) / EDGE : x > r.width - EDGE ? -(x - r.width + EDGE) / EDGE : 0;
    const fy = y < EDGE ? (EDGE - y) / EDGE : y > r.height - EDGE ? -(y - r.height + EDGE) / EDGE : 0;
    if (!fx && !fy) { edgeStop(); return; }
    if (!edge) { edge = {view, fx, fy, since: performance.now(), t: 0, raf: 0, moved: false}; edge.raf = requestAnimationFrame(edgeStep); }
    else { edge.fx = fx; edge.fy = fy; }
  }
  function edgeStep() {
    const g = edge; if (!g) return;
    if (!edgeAllowed() || host()?.view?.() !== g.view) { edgeStop(); return; }
    const now = performance.now();
    if (now - g.since > 150) {
      const dt = g.t ? clamp(now - g.t, 0, 50) : 16, speed = 900 * cfg["camera.panSpeed"] / 1000;
      g.moved = true;
      g.view.pan(clamp(g.fx, -1, 1) * speed * dt, clamp(g.fy, -1, 1) * speed * dt); nudgeFrame(g.view);
    }
    g.t = now; g.raf = requestAnimationFrame(edgeStep);
  }
  function edgeStop() {
    const stopped = edge;
    if (!stopped) return;
    edge = null;
    cancelAnimationFrame(stopped.raf);
    if (stopped.moved) {
      stopped.view.settle?.();
      if (globalThis.AtriumPower?.visible?.() !== false) host()?.redraw?.();
    }
  }
  function edgeSync() {
    const want = edgeAllowed();
    if (want === edgeOn || typeof document === "undefined") return;
    edgeOn = want;
    if (want) { document.addEventListener("pointermove", edgeMove, true); document.addEventListener("pointerleave", edgeStop, true); addEventListener("blur", edgeStop); document.addEventListener("pointerdown", edgeStop, true); }
    else { document.removeEventListener("pointermove", edgeMove, true); document.removeEventListener("pointerleave", edgeStop, true); removeEventListener("blur", edgeStop); document.removeEventListener("pointerdown", edgeStop, true); edgeStop(); }
  }

  // ---------------------------------------------------------------- preferences page
  const KEYS = [
    ["Right button", "Hold and drag to pan; a still click (under 4 px and 250 ms) opens the context menu"],
    ["Middle button, Alt+drag, Space+drag", "Pan"], ["Alt+click", "Highlight the net under the pointer"],
    ["Back / forward thumb buttons", "Previous and next view"],
    ["Tilt wheel, thumb side wheel", "Scroll sideways (every preset)"]
  ];
  const CAMERA_KEYS = [["view-back", "Previous view"], ["view-forward", "Next view"],
    ["camera-pan-left", "Pan when idle with nothing selected. Hold {fast} to pan faster."],
    ["camera-recall-1", "Go to saved views ({recallFirst} … {recallLast} in the Altium preset)"],
    ["camera-store-1", "Save views ({storeFirst} … {storeLast} in the Altium preset)"], ["jump-alert", "Jump to the last alert or edit"],
    ["selmem-store-1", "Store selection memory 1 (… 9)"], ["selmem-add-1", "Add to selection memory 1"], ["selmem-recall-1", "Recall selection memory 1; twice flies to it"]];
  function prefsPage(c, api) {
    const {el} = api, group = title => api.group(c, title);
    let uid = 0;
    const wrap = (g, label, help, keys) => { const w = el("div", "prf-row"); w.dataset.search = (label + " " + (help || "") + " " + (keys || "")).toLowerCase(); g.append(w); return w; };
    const helpText = (w, input, help) => { if (!help) return; const h = el("small", "prf-help", help); h.id = "cam-help-" + (++uid); input.setAttribute("aria-describedby", h.id); w.append(h); };
    function select(g, key, label, options, help) {
      const w = wrap(g, label, help, key), id = "cam-" + key.replace(/\W/g, "-"), l = el("label", "prf-label", label), s = el("select", "ui-field"), ctl = el("span", "prf-control");
      l.htmlFor = s.id = id;
      for (const [v, t] of options) { const o = el("option", null, t); o.value = v; s.append(o); }
      s.value = String(cfg[key]); s.onchange = () => { setPref(key, s.value); };
      ctl.append(s); w.append(l, ctl); helpText(w, s, help); return s;
    }
    function check(g, key, label, help) {
      const w = wrap(g, label, help, key), id = "cam-" + key.replace(/\W/g, "-"), i = el("input", "ui-checkbox"), l = el("label", "ui-checkbox-row");
      w.classList.add("prf-check"); i.type = "checkbox"; i.id = id; i.checked = !!cfg[key]; i.onchange = () => setPref(key, i.checked);
      l.htmlFor = id; l.append(i, el("span", null, label)); w.append(l); helpText(w, i, help); return i;
    }
    function range(g, key, label, help) {
      const w = wrap(g, label, help, key), id = "cam-" + key.replace(/\W/g, "-"), l = el("label", "prf-label", label), i = el("input"), out = el("output", "prf-unit"), ctl = el("span", "prf-control");
      const [lo, hi] = RANGES[key];
      i.type = "range"; i.id = l.htmlFor = id; i.min = String(lo * 100); i.max = String(hi * 100); i.step = "5"; i.value = String(Math.round(cfg[key] * 100));
      out.textContent = i.value + "%"; i.oninput = () => { out.textContent = i.value + "%"; setPref(key, +i.value / 100); };
      ctl.append(i, out); w.append(l, ctl); helpText(w, i, help); return i;
    }
    const wg = group("Mouse wheel");
    select(wg, "mouse.wheel", "Wheel preset", [["zoom", "Wheel zooms (Waffle)"], ["altium", "Wheel scrolls (Altium)"]],
      "In the Altium preset, Ctrl/⌘+wheel zooms. Shift+wheel pans sideways.");
    range(wg, "mouse.zoomSpeed", "Wheel zoom speed");
    check(wg, "mouse.invertZoom", "Invert the wheel zoom direction", "Off: rolling the wheel away from you zooms in.");
    select(wg, "mouse.zoomAt", "Zoom towards", [["pointer", "The pointer"], ["centre", "The centre of the view"]], "Trackpad pinch always zooms at the fingers.");
    const bg = group("Buttons");
    for (const [k, t] of KEYS) { const w = wrap(bg, k, t); w.classList.add("prf-link"); w.append(el("span", "prf-label", k), el("small", "prf-help", t)); }
    const cg = group("Camera");
    check(cg, "camera.animate", "Animate camera moves", "Smooth moves follow your reduced-motion setting.");
    if (globalThis.AtriumLabs?.notebookEnabled() !== false) {
      check(cg, "camera.momentum", "Continue panning after a two-finger swipe", "Touch again to stop. Reduced motion also turns this off.");
      check(cg, "camera.rotate", "Rotate the canvas with two fingers", "Turn two fingers around their midpoint to rotate the view.");
    }
    range(cg, "camera.panSpeed", "Keyboard and edge pan speed");
    select(cg, "camera.edgeScroll", "Edge scrolling", [["auto", "With the RTS camera key preset"], ["on", "On"], ["off", "Off"]],
      "Pan when the pointer rests at a canvas edge.");
    const K = globalThis.AtriumKeymap, rts = wrap(cg, "RTS camera keys WASD preset", "W A S D pan; Altium's W and A, S, D sequences move aside (E, G and E, S keep align and select)");
    rts.classList.add("prf-link");
    const rb = el("button", "prf-button"); rb.type = "button";
    const label = () => { rb.textContent = K?.preset?.() === "rts" ? "Use the Altium-style keys" : "Use the RTS camera keys (WASD)"; };
    rb.onclick = () => { try { K.setPreset(K.preset() === "rts" ? "altium" : "rts"); } catch {} label(); edgeSync(); };
    label();
    const rtsHelp = el("small", "prf-help");
    rtsHelp.append(...AtriumNavCommon.shortcutParts(
      "{pan} pans. {align} aligns. {select} selects.",
      {pan:["W","A","S","D"], align:"E G", select:"E S"}));
    rts.append(rb, rtsHelp);
    const kg = group("Camera keys");
    const list = el("dl", "cam-keys"); list.dataset.search = "keys shortcuts saved views selection memory history";
    for (const [id, text] of CAMERA_KEYS) {
      const term = el("dt"), detail = el("dd"), binding = K?.hintKey(id, host()?.doc()?.kind);
      if (binding && globalThis.AtriumShortcut) term.append(AtriumShortcut.render(binding));
      else term.textContent = "—";
      detail.append(...AtriumNavCommon.shortcutParts(text,
        {fast:"Shift",recallFirst:"J 1",recallLast:"J 9",storeFirst:"J M 1",storeLast:"J M 9"}));
      list.append(term, detail);
    }
    kg.append(list);
    const r = wrap(kg, "Keyboard shortcuts", "rebind"); r.classList.add("prf-link");
    const kb = el("button", "prf-button", "Keyboard shortcuts…"); kb.type = "button"; kb.onclick = () => { try { K?.open?.({kind: host()?.doc?.()?.kind}); } catch {} };
    r.append(kb, el("small", "prf-help", "Every camera key can be rebound."));
  }

  // ---------------------------------------------------------------- attach
  function attach(H) {
    reload(); subscribe();
    const command=(id,title,run)=>{
      H.registerAction(id,()=>{
        const signal=globalThis.AtriumLabs?.notebookSignal(), view=H.view(), owner=H.doc();
        const keyboard=globalThis.document?.documentElement?.dataset?.motionInput==="keyboard";
        if(signal?.aborted)return;
        if(globalThis.AtriumCanvasInput)run(keyboard);
        else globalThis.AtriumLazy?.need("AtriumCanvasInput").then(()=>{
          if(!signal?.aborted&&H.view()===view&&H.doc()===owner)run(keyboard);
        },e=>{if(!signal?.aborted)H.info(e.message);});
      });
      return globalThis.AtriumKeymap?.registerCommand?.({id:"camera:"+id,title,category:"View",action:id});
    };
    let notebookCommands;
    function allowNotebookCommands(enabled) {
      if (!enabled) { for (const handle of notebookCommands || []) handle?.dispose(); notebookCommands = null; return; }
      if (notebookCommands) return;
      notebookCommands=[command("camera-zoom-selection","Zoom to selected object",keyboard=>{
        const id=H.selection()[0],item=H.doc().items.find(i=>i.id===id);
        const box=item?globalThis.AtriumNavCommon?.itemBox(H.doc(),H.defs(),item):globalThis.AtriumCanvasInput?.documentHit(H.doc())?.box;
        if(box) globalThis.AtriumCanvasInput?.zoomBox({view:H.view(),canvas:H.canvas()},box,()=>H.redraw(),{fly:!keyboard});
      })];
      for(const [id,title,step] of [["left","Rotate view counterclockwise",-1],["right","Rotate view clockwise",1],["reset","Reset view rotation",0]]){
        notebookCommands.push(command("camera-turn-"+id,title,()=>{const v=H.view();takeCamera(v);v.rotate(step?step*Math.PI/12:-(v.camera().rotation||0));H.redraw();}));
      }
    }
    allowNotebookCommands(globalThis.AtriumLabs?.notebookEnabled() !== false);
    globalThis.AtriumLabs?.onChange(allowNotebookCommands);
    H.registerAction("view-back", () => step(-1));
    H.registerAction("view-forward", () => step(1));
    H.registerAction("jump-alert", jumpAlert);
    for (const d of Object.keys(DIR)) { H.registerAction("camera-pan-" + d, () => panKey(d, false)); H.registerAction("camera-pan-" + d + "-fast", () => panKey(d, true)); }
    for (let n = 1; n <= 9; n++) { H.registerAction("camera-store-" + n, () => storeView(n)); H.registerAction("camera-recall-" + n, () => recallView(n)); }
    H.addRenderer((d, info) => { if (info?.active) observe(); return null; });
    H.on("change", noteEdit);
    H.on("document", () => { stopFly(); stopGlide(); edgeStop(); seen = null; if (!navigating) itinerary = null; });
    H.on("replace", () => { edgeStop(); itinerary = null; });
    globalThis.AtriumKeymap?.onChange?.(edgeSync);
    globalThis.AtriumPower?.onChange?.(edgeSync);
    edgeSync(); observe();
    // A minimap left open in an earlier session comes back.
    if (cfg["camera.minimap"] && globalThis.AtriumLazy && !globalThis.AtriumMinimap) globalThis.AtriumLazy.need("AtriumMinimap").then(M => M.show?.(true), () => {});
  }
  const moved = new Set();
  function onMoved() { for (const f of moved) try { f(); } catch {} }
  for (const type of ["pointerdown", "keydown", "beforeinput"]) globalThis.addEventListener?.(type, () => stopWheel(), true);
  if (globalThis.AtriumNavCommon?.ready && globalThis.document) globalThis.AtriumNavCommon.ready(attach);
  // Preferences › Mouse and Camera (prefs.js loads lazily too; whichever arrives second registers the page).
  function registerPrefs() {
    const P = globalThis.AtriumPrefs; if (!P?.registerPage) return false;
    P.registerPage({id: "mouse", title: "Mouse and Camera", order: 3.5, resetKeys: Object.keys(DEFAULTS), render: prefsPage,
      keywords: "mouse wheel scroll zoom pan right button drag side wheel tilt thumb back forward buttons camera fly animation rts wasd edge scroll minimap trackpad"});
    return true;
  }
  if (!registerPrefs() && globalThis.document) globalThis.AtriumLazy?.need?.("AtriumPrefs").then(registerPrefs, () => {});

  return {DEFAULTS, wheelAction, wheel, wheelHasMotion, wheelPinch, stopWheel, basicInput, ease, mix, significant, History, jump, flyTo, flightMs, land, glideTo, panBy, stopFly, takeCamera, animate, settle, prefsPage, setPref, cfg,
    clickMs: () => 250, historyFor, alertTarget, onMoved: f => { moved.add(f); return () => moved.delete(f); }, edgeWanted};
})();
