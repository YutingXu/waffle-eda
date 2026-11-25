"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const styles = fs.readFileSync(path.join(__dirname,"../../app/style.css"),"utf8");
const token = name => new RegExp("--" + name + "\\s*:\\s*([^;}]*)").exec(styles)?.[1].trim();
function computedToken(name) {
  const value = token(name) || "";
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? computedToken(alias[1]) : value;
}
const attrs = new Map();
const mediaListeners = new Set(), observers = new Set(), powerListeners = new Set();
let efficient = false, visible = true, frames = 0;
const media = {matches:false, addEventListener(type,fn) { mediaListeners.add(fn); },
  removeEventListener(type,fn) { mediaListeners.delete(fn); }};
const root = {getAttribute:name => attrs.get(name),hasAttribute:name => attrs.has(name)};
globalThis.document = {documentElement:root};
globalThis.matchMedia = () => media;
globalThis.requestAnimationFrame = () => ++frames;
globalThis.MutationObserver = class {
  constructor(update) { this.update = update; }
  observe(target, options) {
    assert.equal(target,root);
    assert.deepEqual(options,{attributes:true,attributeFilter:["data-motion","data-motion-input","data-efficient"]});
    observers.add(this);
  }
  disconnect() { observers.delete(this); }
};
globalThis.AtriumPower = {efficient:() => efficient,visible:() => visible,onChange(fn) {
  powerListeners.add(fn); return () => powerListeners.delete(fn);
}};
globalThis.getComputedStyle = el => ({
  get transform() { return el.live?.transform ?? "none"; },
  get opacity() { return el.live?.opacity ?? "1"; },
  transformOrigin:"20px 10px",
  getPropertyValue:name => computedToken(name.slice(2)),
});
require("../../app/ui/motion.js");
const UI = globalThis.AtriumMotionUI;

function element(left = 0) {
  return {calls:[],live:null,left,isConnected:true,
    getBoundingClientRect() { return {left:this.live?.left ?? this.left,top:0,width:40,height:20}; },
    animate(keyframes, options) {
      let end, interrupt;
      const finished = new Promise((resolve, reject) => { end = resolve; interrupt = reject; });
      const track = {finished,keyframes,options,end,cancels:0,pauses:0,plays:0,currentTime:0,
        pause() { this.pauses++; this.currentTime += 1; },play() { this.plays++; },effect:{setKeyframes(frames) {
        track.keyframes = frames;
      }},cancel:() => {
        track.cancels++;
        this.live = null;
        interrupt(Error("cancelled"));
      }};
      this.calls.push(track);
      return track;
    }};
}
function policy(name,value) {
  if (value === null) attrs.delete(name); else attrs.set(name,value);
  for (const observer of [...observers]) observer.update();
}
function system(enabled) {
  media.matches = enabled;
  for (const change of [...mediaListeners]) change();
}

globalThis.__testDone = (async () => {
  assert.equal(token("ease-decelerate").replace(/\s/g,""),"cubic-bezier(.23,1,.32,1)");
  assert.equal(token("ease-standard").replace(/\s/g,""),"cubic-bezier(.77,0,.175,1)");
  for (const alias of ["ease-accelerate","ease-spring"]) {
    assert.equal(token(alias),"var(--ease-decelerate)");
    assert.equal(computedToken(alias),token("ease-decelerate"));
  }
  const el = element(), events = [];
  const opening = UI.enter(el,{duration:220,done:() => events.push("obsolete open")});
  assert.deepEqual(el.calls[0].keyframes,[
    {transform:"scale(.97)",opacity:0},{transform:"none",opacity:"1"},
  ]);
  assert.deepEqual(el.calls[0].options,{duration:220,easing:token("ease-decelerate"),fill:"both"});
  assert.equal(UI.active(),1);
  assert.equal(observers.size,1);

  el.live = {transform:"matrix(.98, 0, 0, .98, 0, 0)",opacity:".43"};
  const closing = UI.exit(el,{duration:150,to:{opacity:0},done:() => events.push("obsolete close")});
  assert.equal(await opening.finished,false);
  assert.equal(el.calls[0].cancels,1);
  assert.deepEqual(el.calls[1].keyframes,[
    {transform:"matrix(.98, 0, 0, .98, 0, 0)",opacity:".43"},{transform:"none",opacity:0},
  ]);

  el.live = {transform:"matrix(.99, 0, 0, .99, 0, 0)",opacity:".18"};
  const reopening = UI.enter(el,{duration:"fast",curve:"standard",done:() => events.push("open")});
  assert.equal(await closing.finished,false);
  assert.deepEqual(el.calls[2].keyframes[0],{transform:"matrix(.99, 0, 0, .99, 0, 0)",opacity:".18"});
  assert.equal(el.calls[2].options.duration,140);
  assert.equal(el.calls[2].options.easing,token("ease-standard"));
  el.calls[2].end();
  assert.equal(await reopening.finished,true);
  assert.deepEqual(events,["open"]);
  assert.equal(observers.size,0);
  assert.equal(mediaListeners.size,0);
  assert.equal(powerListeners.size,0);

  const out = element(), incoming = element();
  const swap = UI.swap(out,incoming,{exit:{to:{opacity:0},done:() => events.push("hide")}});
  assert.equal(UI.active(),2);
  assert.equal(observers.size,1,"a burst of actions shares a single policy observer");
  policy("data-motion","off");
  assert.deepEqual(events,["open","hide"],"turning motion Off lands pending exits immediately");
  assert.equal(await swap.exit.finished,true);
  assert.equal(await swap.enter.finished,true);
  assert.equal(UI.active(),0);
  UI.enter(incoming,{done:() => events.push("instant")});
  assert.equal(incoming.calls.length,1);
  assert.equal(events.at(-1),"instant");

  policy("data-motion","full");
  const shell = UI.exit(incoming,{done:() => events.push("reduced fade")});
  system(true);
  assert.equal(shell.running,true,"reduced motion retains an active opacity fade");
  assert.deepEqual(incoming.calls[1].keyframes,[{opacity:"1"},{opacity:0}]);
  incoming.calls[1].end();
  assert.equal(await shell.finished,true);
  assert.equal(events.at(-1),"reduced fade");
  const fade = UI.enter(incoming);
  assert.deepEqual(incoming.calls[2].keyframes,[{opacity:0},{opacity:"1"}],"reduced motion omits new transforms");
  incoming.calls[2].end();
  assert.equal(await fade.finished,true);
  system(false);
  assert.equal(UI.enter(incoming,{intent:"keyboard"}).running,false,"keyboard interaction settles immediately");
  const inFlight = UI.enter(incoming,{done:() => events.push("efficient")});
  efficient = true;
  for (const change of [...powerListeners]) change();
  assert.equal(await inFlight.finished,true);
  assert.equal(events.at(-1),"efficient");
  assert.equal(UI.enter(incoming).running,false);
  efficient = false;
  policy("data-motion",null);

  const occluded = element(), hiddenTrack = UI.enter(occluded);
  const animation = occluded.calls[0];
  animation.currentTime = 48;
  visible = false;
  for (const change of [...powerListeners]) change();
  assert.equal(hiddenTrack.running,true,"occlusion keeps the active compositor track");
  assert.equal(animation.pauses,1);
  assert.equal(animation.currentTime,48,"pause restores the evaluated time");
  assert.equal(animation.plays,0);
  visible = true;
  for (const change of [...powerListeners]) change();
  assert.equal(animation.plays,1);
  animation.end();
  assert.equal(await hiddenTrack.finished,true);

  const moved = element(4), stationary = element();
  UI.enter(moved);
  moved.live = {transform:"matrix(1, 0, 0, 1, 6, 0)",left:10,opacity:".7"};
  const [reflow] = UI.flip([moved,stationary],() => { moved.left = 30; },{duration:160});
  assert.deepEqual(moved.calls[1].keyframes,[
    {transform:"translate(-20px,0px) scale(1,1)",opacity:".7"},{transform:"none",opacity:"1"},
  ]);
  assert.equal(stationary.calls.length,0);
  reflow.cancel();
  assert.equal(await reflow.finished,false);
  assert.equal(UI.active(),0);
  assert.equal(observers.size,0);
  assert.equal(frames,0,"WAAPI and the policy observer need no editor RAF");
  console.log("UI motion: shared easing, evaluated reversal, FLIP, occlusion, Off, Reduced Motion, keyboard and Efficiency passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
