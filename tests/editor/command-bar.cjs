"use strict";
// Command line (app/editor/command-bar.js): Allegro-style typed coordinates and Done / Oops / Cancel semantics.
const assert=require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/editor/command-bar.js");
const B=globalThis.AtriumCommandBar;

// Parsing: x X Y, bare X Y, ix, iy, ixy, units, Allegro command words, errors.
assert.deepEqual(B.parse("x 10 20","mm"),{op:"x",v:[10,20]});
assert.deepEqual(B.parse("10, 20","mm"),{op:"x",v:[10,20]});
assert.deepEqual(B.parse("ix 5","mm"),{op:"i",v:[5,0]});
assert.deepEqual(B.parse("iy -2","mm"),{op:"i",v:[0,-2]});
assert.deepEqual(B.parse("ixy 1 2","mm"),{op:"i",v:[1,2]});
assert.deepEqual(B.parse("X 400mil 250mil","mm").v,[10.16,6.35]);
assert.deepEqual(B.parse("x 100 50","mil").v,[2.54,1.27]);
assert.deepEqual(B.parse("add connect"),{op:"cmd",action:"route"});
assert.deepEqual(B.parse("Done"),{op:"cmd",action:"escape-done"});
assert.match(B.parse("x 10").error,/two values/);assert.match(B.parse("ix").error,/one value/);
assert.match(B.parse("x 1 a").error,/not a coordinate/);assert.match(B.parse("frobnicate").error,/Unknown command/);assert.ok(B.parse("").error);

// A fake editor host: the route tool with a live session of n clicks; Escape first finishes (keeps) the route,
// then leaves the tool, as editor.js does; route-back retracts one click and cancels the session at the start.
function fake(o={}){
  const h={calls:[],t:o.tool||"route",live:o.live??0,committed:0,ptr:o.pointer||[0,0],
    tool(){return this.t;},liveRoute(){return this.live>0?{}:null;},doc:()=>({kind:"pcb",grid:1}),units:()=>"mm",pointer(){return this.ptr;},
    view:()=>({worldToScreen:p=>p,flipped:()=>false}),canvas:()=>({clientWidth:100,clientHeight:100}),
    centerOn(p){this.calls.push("centerOn:"+p.join(","));this.ptr=p;},redraw(){},
    executeKey(a,p){
      this.calls.push(p?a+":"+p.join(","):a);
      if(a==="route-back"&&this.live>0)this.live--;
      else if(a==="escape"){if(this.live>0){this.committed+=this.live;this.live=0;}else this.t="select";}
      else if(a==="cursor-step")this.ptr=[this.ptr[0]+p[0],this.ptr[1]+p[1]];
    }};
  globalThis.AtriumNavHost=h;return h;
}
// F6 Done ends the current command and keeps the route.
let h=fake({live:3});B.done();
assert.equal(h.t,"select");assert.equal(h.committed,3,"Done keeps the route");assert.ok(!h.calls.includes("route-back"),"Done retracts nothing");
// F8/F9 Cancel discards the unfinished route click by click, then leaves the tool.
h=fake({live:3});B.cancel();
assert.equal(h.t,"select");assert.equal(h.committed,0,"Cancel keeps nothing");
assert.ok(h.calls.indexOf("escape")>h.calls.lastIndexOf("route-back"),"the route is retracted before the tool ends");
// Cancel while placing: Escape discards the placement.
h=fake({tool:"place"});B.cancel();assert.deepEqual(h.calls,["escape"]);assert.equal(h.t,"select");
// Done and Cancel in Select do nothing.
h=fake({tool:"select"});B.done();B.cancel();assert.deepEqual(h.calls,[]);
// F7 Oops: retract the last routing click while routing, undo otherwise.
h=fake({live:2});B.run("oops");assert.deepEqual(h.calls,["route-back"]);assert.equal(h.live,1);
h=fake({tool:"select"});B.run("oops");assert.deepEqual(h.calls,["undo"]);
// x X Y on screen: the keyboard cursor steps there (no camera move) and the active tool clicks.
h=fake({live:1});assert.match(B.run("x 10 20"),/Picked 10 mm, 20 mm/);
assert.deepEqual(h.calls,["cursor-step:10,20","place-at-pointer"]);
// ix / iy are relative to the last pick.
h.calls.length=0;B.run("ix 5");assert.deepEqual(h.calls,["cursor-step:5,0","place-at-pointer"]);
h.calls.length=0;B.run("iy -2");assert.deepEqual(h.calls,["cursor-step:0,-2","place-at-pointer"]);
// Off screen: the view centres on the point first.
h.calls.length=0;B.run("x 500 500");assert.deepEqual(h.calls,["centerOn:500,500","place-at-pointer"]);
// With no tool active the cursor only moves.
h=fake({tool:"select"});assert.match(B.run("x 1 2"),/Moved the cursor/);assert.deepEqual(h.calls,["cursor-step:1,2"]);
// Typed Allegro commands run editor actions.
h=fake({tool:"select"});B.run("zoom fit");B.run("slide");assert.deepEqual(h.calls,["fit","drag-object"]);
console.log("PASS command bar: x/ix/iy/ixy parsing with units, Done keeps, Cancel discards, Oops retracts or undoes, picks snap through the editor cursor.");
