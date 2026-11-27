"use strict";
// Motion system (app/editor/editor-motion.js, docs/motion.md): the JS tokens match style.css, the
// Full / Reduced / Off levels (data-motion and the system setting), easing curves, the shared frame
// loop (interruptible, lands at once when Off, idle when nothing animates), canvas feedback and CSS.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh motion).
const assert = require("node:assert/strict");
const path = require("node:path");
const {declarations, readStyles, motionProblems} = require("../support/motion-css.cjs");

// ---- a minimal DOM: the root's data-motion, the system setting and a frame queue -------------------
let attr = null, input = null;
const media = {matches: false};
const frames = [];
let clock = 1000, frameId = 0;
globalThis.performance = {now: () => clock};
globalThis.matchMedia = q => (/prefers-reduced-motion/.test(q) ? media : {matches: false});
globalThis.requestAnimationFrame = f => { const callback = at => f(at); callback.id = ++frameId; frames.push(callback); return callback.id; };
globalThis.cancelAnimationFrame = id => { const at = frames.findIndex(frame => frame.id === id); if (at >= 0) frames.splice(at, 1); };
globalThis.getComputedStyle = () => ({getPropertyValue: k => (k === "--accent" ? "#123456" : "")});
globalThis.document = {documentElement: {getAttribute: k => k === "data-motion" ? attr : k === "data-motion-input" ? input : null}};
// Run queued frames at `ms` apart until the queue is empty (or `max` frames).
function run(ms = 16, max = 200) {
  let n = 0;
  while (frames.length && n < max) { clock += ms; const q = frames.splice(0); for (const f of q) f(clock); n++; }
  return n;
}

// ---- a stand-in editor host (AtriumNavHost) ------------------------------------------------------
const listeners = {}, renderers = [];
let overlayFrames = 0, selection = [];
const box = (d, defs, i) => (Number.isFinite(i.x) ? [i.x, i.y, i.x + 2, i.y + 1] : null);
globalThis.AtriumNavCommon = {itemBox: box, union: (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])};
const board = {id: "pcb1", kind: "pcb", items: [{id: "a", kind: "track", x: 0, y: 0}, {id: "b", kind: "part", x: 5, y: 5}]};
let current = board;
const host = {
  addRenderer: f => { renderers.push(f); return () => {}; },
  on: (t, f) => { (listeners[t] ||= []).push(f); return () => {}; },
  doc: () => current, defs: () => new Map(), selection: () => selection, drag: () => null, liveRoute: () => null,
  canvas: () => null, view: () => ({camera: () => ({cx: 0, cy: 0, scale: 1})}), redrawOverlay: () => { overlayFrames++; },
};
globalThis.AtriumNavHost = host;
const emit = (t, detail) => { for (const f of listeners[t] || []) f(detail); };

require("../../app/editor/editor-motion.js");
const M = globalThis.AtriumMotion;

const cssArg = process.argv.indexOf("--css-files");
const styles = readStyles(path.join(__dirname, "../../app"), cssArg < 0 ? undefined : process.argv.slice(cssArg + 1));
assert.ok(styles.has("style.css") && styles.has("ui/controls.css"), "scan includes root and nested app stylesheets");

// ---- token contract and safeguards for app/**/*.css -----------------------------------------------
{
  const roots = declarations("style.css", styles.get("style.css")).filter(rule => rule.stack.join(" ") === ":root");
  const tokens = new Map(roots.map(rule => [rule.property, rule.value]));
  const token = name => tokens.get("--" + name);
  const durations = {instant:80, fast:140, base:200, slow:320, ambient:240};
  const surfaces = {"dialog-in":200, "dialog-out":150, "menu-in":120, "menu-out":80};
  assert.deepEqual(M.DURATIONS, durations, "the shared timing scale, including the camera-only 320ms duration");
  for (const [name, ms] of Object.entries({...durations, ...surfaces})) {
    assert.equal(token("motion-" + name), ms + "ms", "--motion-" + name);
  }
  const curves = {decelerate:[.23, 1, .32, 1], standard:[.77, 0, .175, 1], drawer:[.32, .72, 0, 1]};
  const numbers = css => /^cubic-bezier\((.*)\)$/.exec(css)?.[1].split(",").map(Number);
  for (const [name, target] of Object.entries(curves)) assert.deepEqual(numbers(token("ease-" + name)), target, "--ease-" + name);
  for (const name of ["accelerate", "spring"]) assert.equal(token("ease-" + name), "var(--ease-decelerate)", "--ease-" + name + " aliases ease-out");
  for (const [name, target] of Object.entries({...curves, accelerate:curves.decelerate, spring:curves.decelerate})) {
    assert.deepEqual([...M.EASES[name]], target, "AtriumMotion.EASES." + name);
    assert.deepEqual(numbers(M.cssEase(name)), target, "AtriumMotion.cssEase(" + name + ")");
  }
  assert.deepEqual(roots.map(rule => rule.property).filter(name => name.startsWith("--ease-")).sort(),
    ["--ease-accelerate", "--ease-decelerate", "--ease-drawer", "--ease-spring", "--ease-standard"], "one set of shared curves");
  assert.equal(token("motion-move"), "1", "travel is on by default");
  assert.throws(() => M.duration("glacial"), /Unknown motion duration/);
  assert.throws(() => M.ease("bouncy"), /Unknown motion easing/);

  const tokensForFixtures = `
    :root {--motion-move:1;--fast:120ms;--camera:320ms;--curve-outside:var(--invalid);--invalid:ease-in}
    :root[data-motion=reduce] {--motion-move:0}
    @media (prefers-reduced-motion: reduce) {:root {--motion-move:0}}`;
  const inspect = sample => motionProblems(new Map([["ui/mutation.css", tokensForFixtures + "\n" + sample]])).join("\n");
  assert.equal(inspect(`
    /* transition:all .5s ease-in; .bad:hover {transform:scale(0)} */
    .progress {transform:scaleX(0);transition:transform 140ms linear 500ms}
    .pending {transition-delay:500ms;animation-delay:.3s}
    .alert {animation:enter .2s ease 1s both;content:"transition:all 1s ease-in"}
    @keyframes enter {from {opacity:0;translate:0 calc(8% * var(--motion-move, 1))}}
    @media (hover: hover) { @supports (display:grid) { @media (pointer: fine) {.over:hover {transform:scale(.97)}} } }
    .static {animation:appear 200ms}
    @keyframes appear {from {transform:translateX(20%)}}
    :root[data-motion=reduce] .static {animation:none}
    @media (prefers-reduced-motion: reduce) {.static {animation-name:none}}
    :root[data-motion=reduce] .progress {transition-property:opacity}
    @media (prefers-reduced-motion: reduce) {:root .progress {transition:none}}
    .thumb {scale:.6 1;transition:opacity 140ms,scale 140ms}
    :root:is([data-motion=reduce],[data-efficient]) .thumb {transition-property:opacity}
    @media (prefers-reduced-motion: reduce) {:root .thumb {transition-property:opacity}}
  `), "", "valid delay, genuine zero progress and reduced-motion paths");
  for (const [bad, diagnostic] of [
    [".bad {-webkit-transition: opacity 140ms, all 190ms ease 500ms}", /transition: all/],
    [".bad {--props:all;transition-property:var(--props)}", /transition: all/],
    [".bad {transition: 140ms ease}", /defaulting to all/],
    [".ui-collapse {transition: width 140ms ease}", /transition property width/],
    [".bad {transition-property: grid-template-rows}", /transition property grid-template-rows/],
    [".bad {transition:scale 140ms}\n@media (prefers-reduced-motion: reduce) {.bad {transition-property:opacity}}", /\.bad moves in a transition without a \[data-motion=reduce\] path/],
    [".bad {transition:transform 140ms}\n:root[data-motion=reduce] .bad {transition:none}", /\.bad moves in a transition without a prefers-reduced-motion path/],
    ["@keyframes move {from {margin-left: 1rem}}", /keyframe move animates margin-left/],
    [".bad {-webkit-transform: translateX(5%) scale(calc(1 - 1))}", /scale\(0\)/],
    [".bad {scale:0%}", /scale\(0\)/],
    ["@-webkit-keyframes grow {from {transform:scaleX(0)}}", /scale\(0\)/],
    [".bad {-webkit-animation-timing-function: var(--curve-outside)}", /ease-in/],
    [".bad {transition:opacity 200ms cubic-bezier(0.42, 0.0, 1.0, 1)}", /ease-in/],
    [".bad {--spring-extra:linear(0, 1)}", /shared easing curve definitions/],
    [".bad {-webkit-animation: flash .3s ease 50ms both}", /300ms/],
    [".bad {transition-duration: calc(var(--fast) * 3); transition-delay:100ms}", /360ms/],
    [".bad {transition:opacity var(--no-such-duration, max(140ms, .35s))}", /350ms/],
    [".bad {animation-duration:var(--camera)}", /camera-only/],
    [".subject:is(:hover,:focus-visible){transform:scale(.99)}", /hover transforms/],
    [".subject:hover { & .child {transform:scale(.99)} }", /hover transforms/],
    ["@media (hover:hover), (pointer:fine) {.bad:hover{translate:1% 0}}", /hover transforms/],
    ["@media not (hover:hover) and (pointer:fine) {.bad:hover{rotate:1deg}}", /hover transforms/],
    [".bad {animation:move 140ms} @keyframes move {from {transform:translateX(10%)}}", /moving keyframe move/],
    ["@media (prefers-reduced-motion:no-preference) {.bad{animation:move 200ms}@keyframes move{from {translate:0 5%}}}", /moving keyframe move/],
    ["@keyframes move {from {translate:0 calc(5% + 8% * var(--motion-move))}}", /moving keyframe move/],
  ]) assert.match(inspect(bad), diagnostic, bad);
  assert.deepEqual(motionProblems(new Map([["style.css", ".ui-collapse {transition: grid-template-rows 200ms ease, opacity 200ms ease}"]])),
    [], "section disclosure is the one structural layout transition");
  assert.match(motionProblems(new Map([["ungated.css", "@keyframes move {from {translate:0 calc(5% * var(--motion-move, 1))}}"]])).join("\n"),
    /moving keyframe move/, "the movement token needs both preference paths to turn it off");

  // Decision 1 (2026-11-23): loading indicators may loop past 300 ms; Reduced and the system setting hold them still.
  const loaderCss = body => motionProblems(new Map([["ui/components.css", tokensForFixtures + "\n" + body]])).join("\n");
  const still = `:root[data-motion=reduce] :is(.ui-spinner) {animation:none}
    @media (prefers-reduced-motion: reduce) {:is(.ui-spinner) {animation:none}}`;
  assert.equal(loaderCss(`:is(.ui-spinner) {animation:spin 800ms linear infinite} @keyframes spin {to {rotate:1turn}} ${still}`), "",
    "the spinner may loop when both reduced paths hold it still");
  assert.match(loaderCss(":is(.ui-spinner) {animation:spin 800ms linear infinite} @keyframes spin {to {rotate:1turn}}"),
    /still reduced-motion path/, "a looping loader without a still path");
  assert.match(loaderCss(`.badge {animation:glow 200ms linear infinite} @keyframes glow {from {opacity:.5}}`),
    /only loading indicators/, "nothing else loops, however short");
  assert.match(loaderCss(`.badge {animation:glow 200ms linear; animation-iteration-count:3} @keyframes glow {from {opacity:.5}}`),
    /only loading indicators/, "a repeat count is a loop too");
  assert.match(motionProblems(new Map([["feature.css", `:is(.ui-spinner) {animation:spin 800ms linear infinite} @keyframes spin {to {rotate:1turn}} ${still}`]])).join("\n"),
    /only loading indicators/, "the exception belongs to the library's loaders, not a feature copy");
  assert.match(loaderCss(`:is(.ui-spinner) {animation:spin 800ms linear} ${still} @keyframes spin {to {rotate:1turn}}`),
    /800ms must be below 300ms/, "a loader that does not loop keeps the 300 ms rule");

  const cssProblems = motionProblems(styles);
  assert.equal(cssProblems.length, 0, "CSS motion contract:\n" + cssProblems.join("\n"));
}

// ---- levels: data-motion wins; System follows prefers-reduced-motion --------------------------------
{
  attr = null; media.matches = false;
  assert.equal(M.level(), "full"); assert.equal(M.moves(), true); assert.equal(M.duration("base"), 200);
  media.matches = true;
  assert.equal(M.level(), "reduced", "System + the OS asks for less motion = Reduced");
  assert.equal(M.moves(), false, "Reduced: nothing travels");
  assert.equal(M.enabled(), true, "Reduced: fades still run");
  assert.equal(M.duration("fast"), 140, "Reduced keeps fade durations");
  attr = "full"; assert.equal(M.level(), "reduced", "the OS request for Reduced motion is honoured in Full");
  attr = "reduce"; media.matches = false; assert.equal(M.level(), "reduced"); assert.equal(M.moves(), false);
  attr = "off";
  assert.equal(M.level(), "off"); assert.equal(M.enabled(), false); assert.equal(M.moves(), false);
  for (const n of Object.keys(M.DURATIONS)) assert.equal(M.duration(n), 0, "Off: " + n + " is 0 ms");
  assert.equal(M.duration(500), 0, "Off: any duration is 0 ms");
  attr = null; input = "keyboard"; assert.equal(M.level(), "off", "keyboard-initiated motion is suppressed");
  input = null;
}

// ---- deterministic inspection and retargeting for nonvisual callers ------------------------------
{
  assert.deepEqual(M.describePolicy({requested:"full",input:"pointer",visibility:"occluded",osReduced:true,
    efficient:false,pointerHover:true}), {requested:"full",input:"pointer",visibility:"occluded",osReduced:true,
    efficient:false,level:"reduced",suspended:true,opacity:true,travel:false,hover:false});
  assert.equal(M.describePolicy({input:"keyboard",requested:"full",pointerHover:true}).level,"off");
  assert.equal(M.describePolicy({efficient:true,requested:"full"}).level,"off");
  assert.equal(M.plan({kind:"camera",duration:"slow",level:"full",visibility:"hidden"}).durationMs,320);
  assert.equal(M.plan({kind:"camera",duration:"slow",level:"full",visibility:"hidden"}).disposition,"paused");
  assert.equal(M.plan({kind:"travel",duration:"slow"}).durationMs,299);
  assert.equal(M.plan({kind:"travel",level:"reduced"}).disposition,"immediate");
  assert.equal(M.plan({kind:"fade",level:"reduced"}).durationMs,200);
  assert.equal(M.plan({kind:"fade",level:"off"}).durationMs,0);
  const displayed = M.sample({from:0,to:80,elapsedMs:50,durationMs:200,curve:"linear"});
  assert.deepEqual(displayed,{progress:.25,eased:.25,value:20,finished:false,durationMs:200});
  const redirected = M.retarget({from:0,previousTarget:80,to:-40,elapsedMs:50,durationMs:200,nextDurationMs:140,curve:"linear"});
  assert.deepEqual(redirected,{previous:displayed,from:20,to:-40,durationMs:140,curve:"linear",kind:"fade"});
  assert.equal(M.sample({...redirected,elapsedMs:0}).value,20);
  assert.equal(M.sample({...redirected,elapsedMs:200}).value,-40);
  assert.equal(M.sample({...redirected,elapsedMs:0,durationMs:0}).finished,true);
}

// ---- curves ---------------------------------------------------------------------------------------
{
  for (const n of Object.keys(M.EASES)) { const f = M.ease(n); assert.equal(f(0), 0, n + "(0)"); assert.equal(f(1), 1, n + "(1)"); }
  assert.equal(M.ease("linear")(.37), .37);
  const s = M.ease("standard"); let last = 0;
  for (let t = .05; t <= 1; t += .05) { const v = s(t); assert.ok(v >= last - 1e-9, "standard is monotonic"); last = v; }
  assert.ok(M.ease("decelerate")(.2) > .5, "decelerate arrives early");
  for (const t of [.15, .5, .85]) {
    assert.equal(M.ease("accelerate")(t), M.ease("decelerate")(t), "exits ease out");
    assert.equal(M.ease("spring")(t), M.ease("decelerate")(t), "everyday UI settles without bounce");
  }
  // Against a reference value: CSS ease (.25,.1,.25,1) at x = .5 is about .8024.
  assert.ok(Math.abs(M.bezier([.25, .1, .25, 1])(.5) - .8024) < 1e-3, "bezier solver");
  assert.equal(M.ease("standard"), M.ease("standard"), "curves are cached");
}

// ---- the frame loop -------------------------------------------------------------------------------
{
  attr = null; run(16);
  const seen = []; let done = 0;
  const a = M.animate({duration: "base", ease: "linear", step: (e, t) => seen.push(t), done: () => done++});
  assert.equal(frames.length, 1, "one frame requested");
  run(50);
  assert.equal(done, 1, "finished"); assert.equal(seen[0], 0, "starts on its first frame"); assert.equal(seen.at(-1), 1, "lands exactly");
  assert.equal(frames.length, 0, "idle: no frame is requested once nothing animates");
  assert.equal(M.active(), 0); assert.equal(a.running, false);
  // Interruptible: a cancelled track stops; cancel(true) lands it.
  let last = null, ended = 0;
  const b = M.animate({ms: 1000, step: e => { last = e; }, done: () => ended++});
  run(16, 3); b.cancel(); run(16);
  assert.ok(last < 1 && ended === 0, "cancel stops where it is"); assert.equal(frames.length, 0);
  const c = M.animate({ms: 1000, step: e => { last = e; }, done: () => ended++});
  run(16, 2); c.cancel(true); assert.equal(last, 1); assert.equal(ended, 1, "cancel(true) lands and finishes");
  // Off: no frames at all; the step lands at once.
  attr = "off"; run(16); let off = null, offDone = 0;
  M.animate({duration: "slow", step: e => { off = e; }, done: () => offDone++});
  assert.equal(off, 1); assert.equal(offDone, 1); assert.equal(frames.length, 0, "Off schedules no frames");
  // Reduced: fades still animate (the caller asks moves() before travelling).
  attr = "reduce"; M.animate({duration: "fast", step: () => {}}); assert.equal(frames.length, 1, "Reduced still animates a fade"); run(16);
  attr = null;
}

// ---- visible time, explicit channels and reentrant frame callbacks --------------------------------
{
  const owner = {}, finished = [], values = [];
  let shown = 0;
  function go(to) {
    return M.choreograph(owner,"sample",{ease:"linear", ms:100,
      sample:() => shown,
      step(e,_progress,source) { shown = source + (to - source) * e; values.push(shown); },
      done:() => finished.push(to)});
  }
  const first = go(100);
  run(20, 2);
  assert.equal(shown, 40, "input motion progresses on its first display frame");
  const second = go(80);
  assert.equal(first.running, false, "retarget cancels the displaced command");
  run(20, 1);
  assert.equal(shown, 48, "retarget starts from the painted value");
  document.visibilityState = "hidden";
  M.syncPolicy();
  assert.equal(frames.length, 0, "hiding cancels the queued frame");
  clock += 10_000;
  assert.equal(shown, 48);
  assert.equal(second.running, true);
  document.visibilityState = "visible";
  M.syncPolicy();
  run(20, 1);
  assert.equal(shown, 56, "resume uses visible time only");
  attr = "reduce";
  M.syncPolicy();
  assert.deepEqual(finished, [80]);
  assert.equal(shown, 80);
  assert.equal(frames.length, 0, "Reduced lands travel and leaves no pending frame");
  attr = null;
  let nested;
  const outer = M.animate({step() { if (!nested) nested = M.animate({step:() => values.push("nested")}); }});
  run(10, 1);
  assert.notEqual(values.at(-1), "nested", "a new track never runs in its creator's frame");
  outer.cancel(); nested.cancel();
  assert.equal(frames.length, 0, "cancelling the last track releases its scheduled callback");
}

// ---- the optional guide retargets its visible rectangle and immediate placement cancels it -------
{
  assert.equal(M.butterEnabled(),false);
  globalThis.AtriumLabs = {butterEnabled: feature => feature === "motion"};
  assert.equal(M.butterEnabled(),true);
  const element = {style:{transformOrigin:"center"}}, box = left => ({left,top:0,width:120,height:30});
  const left = () => parseFloat(element.style.left) + Number(/translate\(([-\d.]+)px/.exec(element.style.transform)?.[1] ?? 0);
  M.placeBox(element,box(0));
  M.placeBox(element,box(100));
  assert.equal(left(),0);
  run(20,2);
  const drawn = left();
  assert.ok(drawn > 0 && drawn < 100);
  M.placeBox(element,box(200));
  assert.ok(Math.abs(left() - drawn) < 1e-9,"the target change keeps the displayed edge");
  M.placeBox(element,box(200),{direct:true});
  assert.equal(left(),200);
  assert.equal(frames.length,0);
  M.placeBox(element,null);
  assert.equal(element.style.transformOrigin,"center");
  delete globalThis.AtriumLabs;
}

// ---- theme cross-fade leaves the fallback synchronous ---------------------------------------------
{
  let ran = 0;
  M.crossFade(() => ran++);
  assert.equal(ran, 1, "the theme applies synchronously without browser snapshots");
  assert.equal(frames.length, 0, "the fallback schedules no canvas frames");
}

// ---- canvas effects on the editor host --------------------------------------------------------------
{
  assert.equal(renderers.length, 1, "motion.js attached an overlay renderer");
  const R = renderers[0], fx = M._fx;
  assert.equal(R(board, {active: true}), null, "no overlay while idle");
  // Undo: the replayed track pulses and the removed item fades out dashed.
  run(16);
  const replayed = () => ({
    changed:[{id:"a",kind:"track",x:3,y:0}],
    removed:[{id:"c",kind:"via",x:9,y:9}]
  });
  M.undone(board, replayed);
  assert.equal(fx.pulse.count, 1, "one changed object"); assert.deepEqual([...fx.pulse.boxes.slice(0, 4)], [3, 0, 5, 1]);
  assert.equal(fx.gone.count, 1, "one removed object");
  assert.equal(fx.pulse.ms, 200, "undo feedback fades over 200ms");
  assert.ok(!fx.pulse.move, "undo feedback keeps the changed item in place");
  assert.ok(R(board, {active: true})?.overlay, "the overlay draws while effects live");
  assert.equal(R(board, {active: false}), null, "only the active pane");
  // Paint on a recording 2D context: no throw, and every effect ends on time.
  const ctx = new Proxy({}, {get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; }});
  const paint = R(board, {active: true}).overlay;
  paint(ctx, {scale: 4});
  const before$ = overlayFrames;
  for (let i = 0; i < 40 && frames.length; i++) { clock += 16; const q = frames.splice(0); for (const f of q) f(clock); if (R(board, {active: true})) paint(ctx, {scale: 4}); }
  assert.ok(overlayFrames > before$, "pointer-only overlay frames drive the effect");
  assert.equal(fx.pulse, null); assert.equal(fx.gone, null);
  assert.equal(frames.length, 0, "idle again: no frames once the pulse ends");
  assert.equal(R(board, {active: true}), null);
  // Reduced: the pulse only fades. Off: no pulse.
  attr = "reduce"; M.undone(board, replayed); assert.ok(fx.pulse && !fx.pulse.move); run(16, 60); for (const k in fx) fx[k] = null;
  attr = "off"; run(16);
  M.undone(board, () => assert.fail("Off must skip reading the undo journal"));
  assert.equal(fx.pulse, null, "Off: no pulse"); assert.equal(frames.length, 0);
  attr = null;
  // Placement: a part pushed onto the board settles; a plain track does not.
  run(16); current = {id: "pcb1", kind: "pcb", items: board.items}; emit("document"); for (const k in fx) fx[k] = null; run(16);
  current.items.push({id: "u9", kind: "part", x: 20, y: 20}); emit("change");
  assert.equal(fx.settle?.count, 1, "the placed part settles"); run(16, 60); fx.settle = null;
  current.items.push({id: "t9", kind: "track", x: 1, y: 1}); emit("change"); assert.equal(fx.settle, null, "a track does not");
  // Selection is immediate; tapping arrow keys or clicking the canvas never adds a halo.
  selection = ["a"]; emit("selection"); assert.equal(fx.halo, null, "ordinary selection is still");
  run(16, 60);
}

// ---- pour commits: live tiles already show the copper; an edit ends a cross-fade -------------------
{
  const fx = M._fx, canvas = {width: 8, height: 6};
  host.canvas = () => canvas;
  globalThis.document.createElement = () => ({width: 0, height: 0, getContext: () => ({clearRect() {}, drawImage() {}})});
  const patches = new Map();
  globalThis.AtriumPolygonPour = {tiles: {patches}};
  for (const k in fx) fx[k] = null;
  current = {id: "pcb1", kind: "pcb", items: board.items, pcbDrawing: {pours: [{polygon: "p"}]}};
  emit("document"); run(16, 60); for (const k in fx) fx[k] = null;
  patches.set("p", {doc: current, shown: new Set([3])});
  current.pcbDrawing = {pours: [{polygon: "p", exact: true}]}; emit("change", {source: "pours"});
  assert.equal(fx.fade, null, "an exact fill under shown tile patches does not cross-fade the board");
  patches.clear();
  current.pcbDrawing = {pours: [{polygon: "p"}]}; emit("change", {source: "pours"});
  assert.ok(fx.fade, "without tile patches the new copper cross-fades");
  run(16, 1);
  const before = overlayFrames;
  globalThis.AtriumPower = {efficient: () => true};
  M.syncPolicy();
  assert.equal(fx.fade, null, "Efficiency removes the painted snapshot");
  assert.equal(overlayFrames, before + 1, "clearing effects requests one final overlay repaint");
  assert.equal(frames.length, 0, "Efficiency leaves no animation callbacks pending");
  M.syncPolicy();
  assert.equal(overlayFrames, before + 1, "repeating the setting needs no repaint");
  delete globalThis.AtriumPower;
  assert.ok(M.reveal(), "the canvas can start a later effect after leaving Efficiency");
  fx.fade.start = clock;   // its first frame has drawn
  current.items = [...current.items]; emit("change", {source: "edit"});
  assert.equal(fx.fade, null, "an edit ends the cross-fade in flight");
  run(16, 60);
  delete globalThis.AtriumPolygonPour;
}

console.log("motion: ok");
