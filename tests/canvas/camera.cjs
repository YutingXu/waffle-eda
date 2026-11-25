"use strict";
// Camera and mouse (app/canvas/camera.js), selection memory (app/editor/selection-memory.js), the minimap mapping
// (app/canvas/minimap.js), per-layer opacity (pcb-appearance.js + canvas.js) and their keys (keymap.js).
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh camera).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const store = new Map(), storage = {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
Object.defineProperty(globalThis, "localStorage", {value: storage, configurable: true, writable: true});
for (const m of ["model", "theme", "keymap", "editor-keys", "nav-common", "pcb-appearance", "spatial", "connectivity", "canvas", "motion", "camera", "selection-memory", "minimap"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const C = AtriumCamera, KM = AtriumKeymap;

function nativeWheelProbe() {
  const src = fs.readFileSync(__dirname + "/../../native/macos/main.swift", "utf8");
  const script = src.match(/static let wheelNotchScript = """([\s\S]*?)"""/)[1];
  const epoch = 1760000000000;
  const page = {addEventListener(type, fn) { assert.equal(type, "wheel"); this.capture = fn; }};
  new Function("window", "performance", script)(page, {timeOrigin:epoch});
  return {page, mark(ms, dy, serial, flags=0, x=20, y=40) {
    page.__waffleMarkWheelNotch(epoch+ms, dy, serial, flags, x, y);
  }};
}
const nativeEvent = (timeStamp, deltaY, options={}) => ({isTrusted:true, timeStamp, deltaMode:0, deltaX:0, deltaY, ...options});

// Test the exact script installed by WKWebView, including a packet stamped at its last AppKit event.
{
  const {page, mark} = nativeWheelProbe();
  const read = page.__waffleWheelNotches;
  const marked = (deltas, start, serial) => {
    deltas.forEach((dy, i) => mark(start+i*8, dy, serial+i));
    return nativeEvent(start+(deltas.length-1)*8, deltas.reduce((n, d) => n+d, 0));
  };
  const merged = marked([80,40,80,-80], 10, 1);
  assert.deepEqual(read(merged), [80,40,80,-80].map((deltaY,i) => ({deltaY, timeStamp:10+i*8})));
  assert.equal(page.__waffleIsWheelNotch(merged), true, "a second reader uses the same consumed packet");
  assert.deepEqual(read(marked([80,80], 50, 5)).map(e=>e.deltaY), [80,80]);
  assert.deepEqual(read(marked([80,-80], 75, 7)).map(e=>e.deltaY), [80,-80], "opposing physical steps retain their order");
  const one = marked([40], 105, 9);
  for (const changes of [{isTrusted:false},{timeStamp:115},{deltaY:41},{deltaX:1},{deltaMode:1},{ctrlKey:true}])
    assert.equal(read({...one,...changes}), null, "untrusted, unmatched, lateral or other-modifier wheels remain unclassified");
  page.capture(one);
  assert.deepEqual(read(one), [{deltaY:40,timeStamp:105}], "wheel events over chrome also consume their physical mark");
  mark(140,80,10); mark(148,80,12);
  assert.equal(read(nativeEvent(148,160)), null, "an intervening precise event breaks the physical packet");
  mark(170,80,13); mark(178,80,14,0,22);
  assert.equal(read(nativeEvent(178,160)), null, "marks at different native pointer positions stay separate");
  mark(205,80,15); mark(213,80,16,2);
  assert.equal(read(nativeEvent(213,160,{ctrlKey:true})), null, "different physical modifiers cannot be merged");
  mark(240,40,17); mark(248,40,18);
  assert.equal(read(nativeEvent(244,40)), null, "equally close raw end timestamps leave the event unclassified");
  page.capture(nativeEvent(248,40));
  mark(270,-80,19); mark(279,80,20); mark(281,40,21);
  assert.deepEqual(read(nativeEvent(279.5,40)).map(e=>e.deltaY), [-80,80,40],
    "with bunched AppKit timestamps only an endpoint with a matching signed sum can win");
}

// ---- wheel presets ------------------------------------------------------------------------------
{
  const zoomCfg = {...C.DEFAULTS}, alt = {...C.DEFAULTS, "mouse.wheel": "altium"};
  const notch = {deltaX: 0, deltaY: 120, deltaMode: 0}, line = {deltaX: 0, deltaY: 3, deltaMode: 1}, page = {deltaX: 0, deltaY: 1, deltaMode: 2};
  // Zoom preset (Waffle): a notched wheel zooms at the pointer; out for positive deltaY.
  let a = C.wheelAction(notch, zoomCfg); assert.ok(a.zoom < 1 && a.at === "pointer", "notch zooms out");
  assert.ok(C.wheelAction(line, zoomCfg).zoom < 1, "line mode zooms");
  assert.ok(C.wheelAction({deltaX: 0, deltaY: 100, wheelDeltaY: -120, deltaMode: 0}, zoomCfg).zoom < 1, "Windows Chrome notch (100 px, wheelDelta 120) zooms");
  assert.ok(C.wheelAction({deltaX: 0, deltaY: 40, wheelDeltaY: -120, deltaMode: 0}, zoomCfg).pan, "a trackpad (wheelDelta = −3 × deltaY) pans");
  assert.ok(C.wheelAction(page, zoomCfg, 600).zoom >= Math.exp(-120 * .008) - 1e-12, "page mode is clamped");
  assert.deepEqual(C.wheelAction({...notch, shiftKey: true}, zoomCfg).pan, [-120, 0], "Shift+wheel scrolls sideways");
  assert.deepEqual(C.wheelAction({deltaX: 0, deltaY: 7.5, deltaMode: 0}, zoomCfg).pan, [-0, -7.5], "pixel scrolling pans");
  // Altium preset: the wheel scrolls, Ctrl/⌘ zooms.
  assert.deepEqual(C.wheelAction(notch, alt).pan, [-0, -120]);
  assert.deepEqual(C.wheelAction(line, alt).pan, [-0, -48], "lines are 16 px");
  assert.ok(C.wheelAction({...notch, ctrlKey: true}, alt).zoom < 1); assert.ok(C.wheelAction({...notch, metaKey: true}, alt).zoom < 1);
  assert.deepEqual(C.wheelAction({...notch, shiftKey: true}, alt).pan, [-120, 0]);
  // Tilt and thumb side wheels pan sideways in every preset, in every delta mode.
  for (const c of [zoomCfg, alt]) for (const mode of [0, 1, 2]) assert.deepEqual(C.wheelAction({deltaX: 2, deltaY: 0, deltaMode: mode}, c, 500).pan, [-2 * [1, 16, 500][mode], 0]);
  // Trackpad: two-finger pan, pinch (Ctrl + fractional deltas) at the fingers whatever the anchor preference.
  assert.deepEqual(C.wheelAction({deltaX: 3, deltaY: 4, deltaMode: 0}, alt).pan, [-3, -4]);
  const pinch = C.wheelAction({deltaX: 0, deltaY: -2.5, deltaMode: 0, ctrlKey: true}, {...alt, "mouse.zoomAt": "centre", "mouse.invertZoom": true, "mouse.zoomSpeed": 3});
  assert.ok(pinch.zoom > 1 && pinch.at === "pointer" && Math.abs(Math.log(pinch.zoom) - 2.5 * .008) < 1e-12, "pinch ignores speed, invert and anchor");
  const integral = C.wheelAction({deltaX: 0, deltaY: -3, deltaMode: 0, ctrlKey: true}, {...alt, "mouse.zoomAt": "centre", "mouse.invertZoom": true});
  assert.ok(integral.at === "pointer" && integral.zoom === Math.exp(3 * .008), "whole-pixel pinch updates keep the same anchor and direction");
  // Speed, invert, anchor.
  const fast = C.wheelAction(notch, {...zoomCfg, "mouse.zoomSpeed": 2}), base = C.wheelAction(notch, zoomCfg);
  assert.ok(Math.abs(Math.log(fast.zoom) - 2 * Math.log(base.zoom)) < 1e-12);
  assert.ok(C.wheelAction(notch, {...zoomCfg, "mouse.invertZoom": true}).zoom > 1);
  assert.equal(C.wheelAction(notch, {...zoomCfg, "mouse.zoomAt": "centre"}).at, "centre");
  // High-resolution wheel deltas zoom (with Ctrl) in proportion, so small steps stay small.
  const small = C.wheelAction({deltaX: 0, deltaY: 4, deltaMode: 0, ctrlKey: true}, alt);
  assert.ok(small.zoom < 1 && small.zoom > .96);
  // The editor hook: zoom at the pointer or the centre, pan otherwise.
  const calls = [], view = {zoom: (f, at) => calls.push(["zoom", f, at]), pan: (x, y) => calls.push(["pan", x, y])};
  C.setPref("mouse.wheel", "altium");
  assert.equal(C.wheel(notch, view, [10, 20], {clientWidth: 400, clientHeight: 300}), true); assert.deepEqual(calls.at(-1), ["pan", -0, -120]);
  C.setPref("mouse.zoomAt", "centre"); C.wheel({...line, ctrlKey: true}, view, [10, 20], {clientWidth: 400, clientHeight: 300});
  assert.deepEqual(calls.at(-1).slice(2), [[200, 150]]);
  C.setPref("mouse.zoomAt", "pointer"); C.setPref("mouse.wheel", "zoom");
  assert.equal(C.setPref("mouse.zoomSpeed", 9), 3, "speed is clamped"); C.setPref("mouse.zoomSpeed", 1);
  assert.equal(C.setPref("mouse.wheel", "bogus"), "zoom");
  assert.equal(JSON.parse(store.get("atrium.prefs")).values["mouse.zoomSpeed"], 1, "stored with the other preferences");
}

// ---- wheel glide -------------------------------------------------------------------------------
{
  const restore = new Map(["performance", "requestAnimationFrame", "cancelAnimationFrame", "AtriumMotion", "AtriumPower", "__waffleIsWheelNotch", "__waffleWheelNotches", "__waffleFrameTrace"]
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let now = 100, serial = 0, moves = true, efficient = false, draws = 0;
  const queue = new Map(), drawInFrame = [], traced = [];
  const motionMoves = AtriumMotion.moves;
  Object.assign(globalThis, {
    performance: {now: () => now}, AtriumMotion: {...globalThis.AtriumMotion,moves: () => moves && motionMoves()},
    AtriumPower: {visible: () => true, efficient: () => efficient},
    requestAnimationFrame: step => { queue.set(++serial, step); return serial; },
    cancelAnimationFrame: id => queue.delete(id)
  });
  const tick = ms => { now += ms; const batch = [...queue.values()]; queue.clear(); for (const step of batch) step(now); };
  const canvas = {isConnected: true, clientWidth: 400, clientHeight: 300};
  const view = AtriumCanvas.create({...canvas, getContext: () => ({}), getBoundingClientRect: () => ({width: 400, height: 300})});
  view.resized();
  const anchor = [83, 114], latest = [276, 62], close = (a, b) => Math.abs(a - b) < 1e-9;
  const notch = {deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120}, factor = C.wheelAction(notch).zoom;
  const trackpad = {deltaX: 0, deltaY: -80, deltaMode: 0, wheelDeltaY: 240};
  const turn = (e, at = anchor) => C.wheel(e, view, at, canvas, inFrame => { draws++; drawInFrame.push(inFrame); });
  try {
    const initial = view.scale(), world = view.screenToWorld(anchor);
    turn(notch);
    assert.equal(view.scale(), initial, "a wheel notch does not jump on delivery");
    assert.equal(draws, 0);
    tick(0);
    tick(60);
    assert.equal(drawInFrame.at(-1), true, "the zoom draw joins the current animation frame");
    assert.ok(close(view.scale(), initial * Math.pow(factor, AtriumMotion.ease("decelerate")(.5))));
    assert.ok(world.every((n, i) => close(n, view.screenToWorld(anchor)[i])));
    const visible = view.scale(), latestWorld = view.screenToWorld(latest);
    turn(notch, latest);
    assert.equal(view.scale(), visible, "retargeting starts from the currently shown scale");
    assert.equal(queue.size, 1, "retargeting replaces the previous frame");
    tick(0);
    tick(119);
    assert.ok(view.scale() < initial * factor * factor);
    tick(1);
    assert.ok(close(view.scale(), initial * factor * factor), "queued notches accumulate targets");
    assert.ok(latestWorld.every((n, i) => close(n, view.screenToWorld(latest)[i])));
    assert.equal(queue.size, 0, "there are no idle frames");

    const ctrlPacket = (dy, legacy) => ({...notch, ctrlKey:true, isTrusted:true,
      timeStamp:now, deltaY:dy, wheelDeltaY:legacy});
    // Observed WebView2 packet shapes: single notches, a net-zero packet, and a
    // packet carrying two same-sign detents. The latter both contribute zoom.
    view.restoreCamera({...view.camera(),cx:0,cy:0,scale:8}); C.stopWheel(view);
    const beforePacket = view.camera(), packetAnchor = view.screenToWorld(anchor);
    turn(ctrlPacket(-100,120)); tick(30);
    turn(ctrlPacket(100,-120)); tick(30);
    turn(ctrlPacket(-200,240)); tick(30);
    const partial = view.camera(), beforeZero = draws;
    const zero = ctrlPacket(0,0);
    turn(zero);
    assert.equal(C.wheelPinch(zero), false, "a net-zero packet is not a touchpad pinch");
    assert.equal(C.wheelHasMotion(zero), false);
    assert.equal(draws, beforeZero, "a net-zero packet does not draw");
    assert.deepEqual(view.camera(), partial);
    assert.equal(queue.size, 1, "a net-zero packet does not interrupt the pending glide");
    turn(ctrlPacket(100,-120)); tick(121);
    assert.ok(close(view.scale(), beforePacket.scale*factor), "alternate and coalesced detents land at the signed target");
    assert.ok(packetAnchor.every((n, i) => close(n, view.screenToWorld(anchor)[i])));
    assert.equal(queue.size, 0);

    turn(ctrlPacket(-100,120)); tick(30);
    const beforePinch = view.scale(), pinch = ctrlPacket(-40,120);
    assert.equal(C.wheelPinch(pinch), true, "the browser's 3:1 legacy ratio still means pinch");
    turn(pinch); tick(121);
    assert.ok(close(view.scale(), beforePinch*Math.exp(.32)), "a genuine pinch immediately takes over an in-flight glide");
    assert.equal(queue.size, 0);

    const beforePan = view.camera();
    turn(notch); turn(trackpad);
    assert.equal(view.scale(), beforePan.scale, "large continuous trackpad deltas do not become a notch");
    assert.notEqual(view.camera().cy, beforePan.cy, "trackpad pan applies immediately");
    assert.equal(drawInFrame.at(-1), undefined, "input handlers keep scheduling their normal draw");
    assert.equal(queue.size, 0);
    turn({...trackpad, wheelDeltaY: 0, ctrlKey: true});
    assert.ok(view.scale() > beforePan.scale, "even an integral Ctrl pixel pinch applies immediately");
    assert.equal(queue.size, 0);
    turn(notch);
    C.basicInput({frame() {}, busy: () => false}).clear();
    assert.equal(queue.size, 0, "input context cleanup cancels the frame");
    globalThis.__waffleIsWheelNotch = () => true;
    turn({...notch, isTrusted: true, timeStamp: now - 1});
    assert.equal(queue.size, 0, "a deferred native notch from before the context switch cannot restart it");
    globalThis.__waffleFrameTrace = {wheel: (_, stamp) => traced.push(stamp)};
    const eventStamp = now;
    const ctrl = {...notch, ctrlKey: true, isTrusted: true, timeStamp: eventStamp};
    turn(ctrl); turn({...ctrl, timeStamp: now + 1});
    tick(16); tick(120);
    assert.deepEqual(traced, [eventStamp], "the first draw is attributed to the earliest pending Control notch");
    moves = false;
    turn({...notch, deltaY: 100, wheelDeltaY: -120});
    assert.equal(queue.size, 0, "reduced and off use the same direct camera path");

    // Cocoa can queue several physical detents while WebKit is busy. Their timestamps precede both handlers.
    const deltas = [-40, 80, -40, -80, 80, 40], sum = deltas.reduce((a, b) => a + b, 0);
    for (const [preset, ctrlKey, fullMotion, efficiency] of [
      ["altium", false, true, false], ["zoom", false, true, false], ["zoom", false, false, false],
      ["altium", true, false, false], ["zoom", true, true, true]
    ]) {
      C.setPref("mouse.wheel", preset);
      moves = fullMotion; efficient = efficiency;
      view.restoreCamera({...view.camera(),cx:0,cy:0,scale:8}); C.stopWheel(view);
      const start = now, before = view.camera(), worldAtAnchor = view.screenToWorld(anchor);
      now += 90;
      const count = draws;
      turn({...notch, ctrlKey, isTrusted:true, timeStamp:start - 1});
      assert.equal(draws, count, "a native event from before a real tool or view switch is discarded");
      assert.deepEqual(view.camera(), before);
      deltas.forEach((deltaY, i) => turn({...notch, ctrlKey, deltaY, isTrusted:true, timeStamp:start + i + 1}));
      const direct = !fullMotion || efficiency || preset === "altium" && !ctrlKey;
      if (direct) assert.equal(draws - count, deltas.length, "every queued direct wheel event reaches the camera");
      if (preset === "altium" && !ctrlKey) {
        assert.ok(close(view.camera().cy, before.cy + sum / before.scale), "queued Altium pan conserves signed detents");
      } else {
        if (fullMotion && !efficiency) tick(121);
        assert.ok(close(view.scale(), before.scale * Math.exp(-sum * .008)), "queued zoom conserves signed detents");
        assert.ok(worldAtAnchor.every((n, i) => close(n, view.screenToWorld(anchor)[i])), "queued zoom keeps its pointer anchor");
      }
      assert.equal(queue.size, 0, "the wheel leaves no animation after settling");
    }
    const native = nativeWheelProbe();
    globalThis.__waffleIsWheelNotch = native.page.__waffleIsWheelNotch;
    globalThis.__waffleWheelNotches = native.page.__waffleWheelNotches;
    C.setPref("mouse.wheel", "zoom"); efficient = false;
    C.setPref("mouse.zoomSpeed", 1.25);
    let nativeSerial = 0;
    for (const [steps, fullMotion, scale, staleFirst] of [
      [[80,40,80,-80], false, 8, false], [[80,80], true, 8, false],
      [[-120,120], false, 1000, false], [[40,-80], false, 8, true]
    ]) {
      moves = fullMotion;
      view.restoreCamera({...view.camera(),cx:0,cy:0,scale}); C.stopWheel(view);
      const cut = now, pointer = view.screenToWorld(anchor);
      const first = cut + (staleFirst ? -7 : 1), end = first + (steps.length-1)*8;
      steps.forEach((dy,i)=>native.mark(first+i*8,dy,++nativeSerial));
      now = end + 30;
      const packet = nativeEvent(end, steps.reduce((n,dy)=>n+dy,0));
      assert.equal(C.wheelHasMotion(packet), true, "a zero-sum macOS packet with actual marked steps remains actionable");
      turn(packet);
      if (fullMotion) tick(121);
      const expected = steps.slice(staleFirst ? 1 : 0).reduce((n,dy)=>Math.min(2000,n*Math.exp(-dy*.008*1.25)),scale);
      assert.ok(close(view.scale(),expected), "coalesced native steps apply in order with per-step limits and owner cutoff");
      assert.ok(pointer.every((n,i)=>close(n,view.screenToWorld(anchor)[i])), "coalesced steps keep the actual pointer anchor");
    }
    C.setPref("mouse.zoomSpeed", 1);
    moves = true;
    efficient = false;
    view.restoreCamera({...view.camera(), scale: view.zoomScale(Infinity)});
    turn(notch);
    assert.equal(queue.size, 0, "wheel at the zoom limit schedules no frame");

    view.restoreCamera({...view.camera(),cx:0,cy:0,scale:8});
    const from=view.camera(), nearby={...from,cx:12}, distant={...from,cx:300};
    assert.equal(C.flightMs(from,nearby,canvas),200,"ordinary camera flights use the base duration");
    assert.equal(C.flightMs(from,distant,canvas),320,"large moves use the camera-only slow duration");
    C.flyTo(distant,{view,canvas,redraw:()=>draws++});
    tick(0);tick(160);
    assert.ok(close(view.camera().cx,distant.cx*AtriumMotion.ease("standard")(.5)));
    tick(139);
    assert.ok(view.camera().cx<distant.cx,"the shared engine keeps the large camera duration");
    tick(21);
    assert.deepEqual(view.camera(),distant);
    assert.equal(queue.size,0,"a landed flight releases the shared frame");
    C.flyTo(nearby,{view,canvas,ms:0,redraw:()=>draws++});
    assert.deepEqual(view.camera(),nearby,"explicitly keyboard-originated camera commands land at once");
  } finally {
    C.stopWheel();
    C.stopFly();
    for (const [name, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

// ---- motion and history -------------------------------------------------------------------------
{
  assert.equal(C.ease(0), 0); assert.equal(C.ease(1), 1); assert.ok(C.ease(.5) > .5, "ease-out");
  const m = C.mix({cx: 0, cy: 0, scale: 1}, {cx: 10, cy: 20, scale: 4}, .5);
  assert.deepEqual([m.cx, m.cy, m.scale], [5, 10, 2], "centre linear, scale geometric");
  const size = [900, 600];
  assert.equal(C.significant({cx: 0, cy: 0, scale: 10}, {cx: 5, cy: 0, scale: 10}, size), false, "50 px pan is the same step");
  assert.equal(C.significant({cx: 0, cy: 0, scale: 10}, {cx: 40, cy: 0, scale: 10}, size), true, "400 px pan is a new step");
  assert.equal(C.significant({cx: 0, cy: 0, scale: 10}, {cx: 0, cy: 0, scale: 15}, size), true, "1.5× zoom is a new step");
  const h = new C.History(3);
  for (const x of [0, 100, 200, 300]) h.note({cx: x, cy: 0, scale: 10}, size);
  assert.equal(h.list.length, 3, "bounded"); assert.equal(h.list[0].cx, 100);
  assert.equal(h.back().cx, 200); assert.equal(h.back().cx, 100); assert.equal(h.back(), null);
  assert.equal(h.forward().cx, 200);
  h.note({cx: 202, cy: 0, scale: 10}, size); assert.equal(h.list.length, 3, "a small move updates the current step"); assert.equal(h.list[1].cx, 202);
  h.note({cx: 900, cy: 0, scale: 10}, size); assert.equal(h.canForward, false, "a new step drops the forward views"); assert.equal(h.list.at(-1).cx, 900);
  assert.equal(C.animate(), false, "no animation without requestAnimationFrame");
}

// ---- keys ---------------------------------------------------------------------------------------
{
  const P = {kind: "pcb", tool: "select", canvas: true}, S = {kind: "schematic", tool: "select", canvas: true}, sel = {selected: true, selectionCount: 1};
  const placing = {...P, tool: "place", interactive: true}, routing = {...P, tool: "route", interactive: true};
  const want = [
    ["Left", P, "camera-pan-left"], ["Up", S, "camera-pan-up"], ["Shift+Right", P, "camera-pan-right-fast"], ["Shift+Down", S, "camera-pan-down-fast"],
    ["Left", {...P, ...sel}, "cursor-left"], ["Left", placing, "cursor-left"], ["Shift+Up", routing, "cursor-up-10"], ["Mod+Left", {...P, ...sel}, "nudge-left"],
    ["Alt+Left", P, "view-back"], ["Alt+Right", S, "view-forward"], ["J E", P, "jump-alert"], ["J 1", P, "camera-recall-1"], ["J 9", S, "camera-recall-9"],
    ["J M 3", P, "camera-store-3"], ["J C", P, "goto-object"], ["Mod+1", P, "selmem-store-1"], ["Ctrl+9", S, "selmem-store-9"], ["Meta+Shift+4", P, "selmem-add-4"],
    ["Alt+5", P, "selmem-recall-5"], ["1", P, "view-planning"], ["2", routing, "route-via"], ["W", P, "route"], ["A L", {...S, ...sel}, "align-left"]
  ];
  for (const [k, s, id] of want) assert.equal(KM.resolve(k, s), id, k + " on " + s.kind + " (" + s.tool + ")");
  // Mod+Shift+1 types "!" on a US layout: it still reaches selection memory 1.
  const ran = [], keys = AtriumEditorKeys.create(a => ran.push(a), () => {});
  const ev = (key, code, o) => ({key, code, repeat: false, isComposing: false, defaultPrevented: false, target: {tagName: "CANVAS"}, preventDefault() { this.defaultPrevented = true; }, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o});
  keys.handle(ev("!", "Digit1", {ctrlKey: true, shiftKey: true}), {...P, canvas: true, documentId: "d"});
  keys.handle(ev("¡", "Digit2", {altKey: true}), {...P, canvas: true, documentId: "d"});
  keys.handle(ev("ArrowLeft", "ArrowLeft", {}), {...P, canvas: true, documentId: "d"});
  assert.deepEqual(ran, ["selmem-add-1", "selmem-recall-2", "camera-pan-left"]);
  assert.deepEqual(KM.conflicts(), [], "no conflicts");
  // The opt-in RTS preset: WASD pan, Altium's W/A/S/D sequences give way, E G and E S keep align and select.
  KM.setPreset("rts");
  assert.deepEqual(KM.conflicts().map(c => c.message), []);
  for (const [k, s, id] of [["W", P, "camera-pan-up"], ["A", S, "camera-pan-left"], ["S", {...P, ...sel}, "camera-pan-down"], ["D", P, "camera-pan-right"], ["W", routing, null],
    ["E G L", {...P, ...sel}, "align-left"], ["E S I", P, "select-inside"], ["Ctrl+W", P, "route"], ["P T", P, "route"], ["Left", P, "camera-pan-left"], ["T D", P, "drc"]])
    assert.equal(KM.resolve(k, s), id, "RTS preset: " + k);
  assert.equal(KM.resolve("D R", P), null, "D is a single key in the RTS preset");
  globalThis.AtriumPref.set("camera.edgeScroll", "auto"); C.setPref("camera.edgeScroll", "auto");
  assert.equal(C.edgeWanted(), true, "edge scrolling follows the RTS preset");
  KM.setPreset("altium"); assert.equal(C.edgeWanted(), false);
  C.setPref("camera.edgeScroll", "on"); assert.equal(C.edgeWanted(), true); C.setPref("camera.edgeScroll", "auto");
}

// ---- selection memory ---------------------------------------------------------------------------
{
  const doc = {id: "b", kind: "pcb", items: [{id: "v1", kind: "via", x: 0, y: 0, diameter: .6}, {id: "v2", kind: "via", x: 10, y: 0, diameter: .6}, {id: "v3", kind: "via", x: 50, y: 50, diameter: .6}]};
  let selection = [], info = "", cam = {cx: 0, cy: 0, scale: 5, referenceScale: 5};
  globalThis.AtriumNavHost = {currentId: () => "b", doc: () => doc, defs: () => new Map(), selection: () => selection.slice(), select: ids => { selection = ids.slice(); }, info: t => { info = t; },
    canvas: () => ({clientWidth: 800, clientHeight: 600, focus() {}}), view: () => ({camera: () => cam, restoreCamera: c => { cam = c; }}), redraw() {}};
  const M = AtriumSelectionMemory; M._reset();
  selection = ["v1", "v2"]; M.store(1, false); assert.deepEqual(M.slot("b", 1), ["v1", "v2"]); assert.match(info, /Stored in selection memory 1: 2 objects/);
  selection = ["v3"]; M.store(1, true); assert.deepEqual(M.slot("b", 1), ["v1", "v2", "v3"], "Shift adds");
  selection = []; M.recall(1); assert.deepEqual(selection, ["v1", "v2", "v3"]); assert.match(info, /Again to fly/);
  M.recall(1); assert.match(info, /in view/, "a second recall flies"); assert.ok(Math.abs(cam.cx - 25) < 1e-9 && Math.abs(cam.cy - 25) < 1e-9, "camera centred on the group");
  doc.items.pop(); selection = []; M.recall(1); assert.deepEqual(selection, ["v1", "v2"], "deleted objects drop out");
  M.recall(2); assert.match(info, /is empty/);
  selection = []; M.store(1, false); assert.deepEqual(M.slot("b", 1), [], "storing nothing clears");
  selection = ["v1"]; M.store(4, false); assert.deepEqual(JSON.parse(store.get("atrium.selmem.v1")), {b: {4: ["v1"]}}, "persisted");
  delete globalThis.AtriumNavHost;
}

// ---- minimap mapping ----------------------------------------------------------------------------
{
  const d = {kind: "pcb", outline: [[0, 0], [100, 0], [100, 50], [0, 50]], items: []}, m = AtriumMinimap.mapping(d);
  const a = m.to([0, 0]), b = m.to([100, 50]);
  assert.ok(a[0] >= 0 && b[0] <= 220 && a[1] >= 0 && b[1] <= 150, "the board fits the minimap");
  assert.deepEqual(m.from(m.to([30, 20])).map(x => +x.toFixed(9)), [30, 20]);
}

// ---- per-layer opacity --------------------------------------------------------------------------
{
  const PCB = AtriumPCBAppearance;
  assert.equal(PCB.layerAlpha("Top"), 1);
  assert.ok(PCB.setLayerOpacity("Top", .4)); assert.equal(PCB.layerAlpha("Top"), .4); assert.equal(PCB.layerOpacity.Top, .4);
  assert.ok(PCB.setOpacity("layer:Bottom", .25), "settings import path"); assert.equal(PCB.layerAlpha("Bottom"), .25);
  const saved = JSON.parse(store.get(PCB.storageKey)).opacity;
  assert.deepEqual(saved, {"layer:Top": .4, "layer:Bottom": .25}, "stored with the colours");
  // The renderer multiplies layer × object alpha.
  assert.ok(PCB.setOpacity("track", .5));
  const alphas = [];
  const target = {globalAlpha: 1, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {}, ellipse() {}, fill() {}, fillRect() {}, fillText() {}, closePath() {}, clip() {},
    stroke() { alphas.push([this.strokeStyle, +this.globalAlpha.toFixed(3)]); }, measureText: () => ({width: 1}), setTransform() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {}};
  const ctx = new Proxy(target, {get: (o, k) => o[k] ?? (() => {}), set: (o, k, v) => { o[k] = v; return true; }});
  const view = AtriumCanvas.create({getContext: () => ctx, getBoundingClientRect: () => ({width: 400, height: 300}), width: 400, height: 300});
  const board = {id: "p", kind: "pcb", grid: .25, outline: [[0, 0], [20, 0], [20, 20], [0, 20]], items: [
    {id: "t1", kind: "track", layer: "Top", width: .3, points: [[2, 2], [10, 2]]}, {id: "t2", kind: "track", layer: "Bottom", width: .3, points: [[2, 6], [10, 6]]}]};
  view.fit(board, new Map(), "board"); view.render(board, new Map(), {layer: "Top"});
  const top = alphas.filter(([s]) => s === PCB.color("Top")).map(x => x[1]), bottom = alphas.filter(([s]) => s === PCB.color("Bottom")).map(x => x[1]);
  assert.ok(top.includes(.2), "Top track: 0.4 × 0.5, got " + top); assert.ok(bottom.includes(.125), "Bottom track: 0.25 × 0.5, got " + bottom);
  PCB.setLayerOpacity("Top", 1); assert.equal(PCB.layerOpacity.Top, undefined);
  PCB.reset(); assert.equal(PCB.layerAlpha("Bottom"), 1, "reset clears layer opacity");
}
console.log("PASS camera: wheel presets (zoom / Altium, tilt and side wheels, pinch, speed, invert, anchor), view history, keys and the RTS preset, selection memory, minimap mapping, per-layer opacity.");
