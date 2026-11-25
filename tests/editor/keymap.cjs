"use strict";
const assert=require("node:assert/strict");
require("../../app/editor/labs.js");
require("../../app/editor/keymap.js");
require("../../app/editor/keymap-presets.js"); // Waffle Classic and KiCad-like (lazy in the app)
require("../../app/editor/editor-keys.js");

// Frozen copy of the pre-keymap handler (app/editor/editor-keys.js before the keymap refactor).
// The keymap test replays every key in many editor states through both and compares.
const legacy=(()=>{
  const chords=[
    ["p","w","route","Wire","schematic"],["p","p","library","Component","schematic"],
    ["p","n","label","Net label","schematic"],["p","j","junction","Junction","schematic"],
    ["p","t","route","Route track","pcb"],["p","v","via","Via","pcb"],
    ["p","c","library","Component","pcb"],["p","s","label","String","pcb"],
    ["v","f","fit-objects","Fit objects"],["v","d","fit-document","Fit document"],
    ["m","m","move-object","Move object"],["x","a","deselect","Deselect all"],
    ["d","r","rules","Design rules","pcb"]
  ];
  const groups={p:"Place",v:"View",m:"Move",x:"Deselect",d:"Design"};
  const isForm=el=>!!(el?.isContentEditable||el?.closest?.("input,textarea,select,[contenteditable=true],[contenteditable=plaintext-only],[role=textbox]"));
  const dir={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]};
  function create(run,hint){
    let prefix="",owner=null;
    function clear(){
      if(prefix){prefix="";owner=null;hint("");}
    }
    function handle(e,s){
      if(e.defaultPrevented || e.isComposing || e.key==="Process" || !e.key)return false;
      if(s.modal || isForm(e.target)){
        clear();
        // Save commits the active inspector field. Text editing retains native undo/clipboard handling.
        if(!s.modal && (e.ctrlKey||e.metaKey) && !e.shiftKey&&!e.altKey && e.key.toLowerCase()==="s"){
          e.preventDefault();if(!e.repeat)run("save");return true;
        }
        return false;
      }
      const k=e.key.toLowerCase();
      if(["shift","control","meta","alt","capslock"].includes(k))return false;
      if(owner!==s.documentId)clear();
      function exec(action,param,repeatable=false){
        e.preventDefault();
        if(!e.repeat || repeatable)run(action,param);
        return true;
      }
      const canvasKey=s.canvas || e.target?.tagName==="BODY";
      if(e.altKey || (e.ctrlKey&&e.metaKey)){clear();return false;}
      if(e.ctrlKey||e.metaKey){
        clear();
        if(k==="m" && e.ctrlKey && !e.shiftKey)return exec("measure");
        if(k==="w" && e.ctrlKey && !e.shiftKey)return exec(s.tool==="route"?"keep-routing":"route");
        if(s.kind==="pcb" && k==="d" && !e.shiftKey)return exec("layer-controls");
        if(s.kind==="pcb" && k==="l" && !e.shiftKey)return exec("view-config");
        if(k==="pagedown" && !e.shiftKey)return exec(s.kind==="pcb"?"fit-document":"fit-objects");
        if((k==="\\" || e.code==="Backslash") && !e.shiftKey)return exec("split-toggle");
        if(k==="g" && s.kind==="schematic" && e.shiftKey && e.ctrlKey)return exec("grid");
        if(k==="g" && !e.shiftKey)return exec("grid-custom");
        if(k in dir && canvasKey && s.selected && e.ctrlKey)return exec("nudge",dir[k].map(n=>n*(e.shiftKey?10:1)),true);
        const action=({s:"save",o:"open",z:e.shiftKey?"redo":"undo",y:"redo",c:"copy",v:"paste",a:"select-all",d:"duplicate",x:"cut"})[k];
        if(action && (!e.shiftKey||k==="z"))return exec(action);
        return false;
      }
      if(k==="f1" || k==="?"){clear();return exec("shortcuts");}
      if(k==="escape"){
        if(prefix){clear();return exec("prefix-cancel");}
        return exec("escape");
      }
      if(!e.shiftKey && prefix){
        if(e.repeat){e.preventDefault();return true;}
        const choice=chords.find(([p,key,,,kind])=>prefix===p && key===k && (!kind || kind===s.kind));
        clear();
        if(choice)return exec(choice[2]);
        if(k.length===1){e.preventDefault();return true;}
      }
      if(k===" " || e.code==="Space"){
        if(!canvasKey && e.target?.closest?.("button,summary,[role=button]"))return false;
        if(s.tool==="route")return exec(e.shiftKey?"route-mode":"route-bend");
        if(s.rotatable)return exec(e.shiftKey?"rotate-cw":"rotate-ccw");
        if(!e.shiftKey)return exec("pan-hold");
        return false;
      }
      if(k==="enter" && canvasKey){
        if(s.interactive)return exec("place-at-pointer");
        if(s.cursorAt && s.tool==="select")return exec("select-at-pointer");
      }
      if(k==="tab" && !e.shiftKey && s.canProperties && canvasKey)return exec("tool-properties");
      if(k in dir && canvasKey){
        const step=dir[k].map(n=>n*(e.shiftKey?10:1));
        return exec("cursor-step",step,true);
      }
      if(k==="backspace"||k==="delete"){
        if(s.tool==="route")return exec("route-back",null,true);
        if(s.interactive)return false;
        return s.selected?exec("delete"):false;
      }
      if(k==="pageup"||k==="pagedown"){
        const scale=e.shiftKey && s.kind==="pcb"?1.1:1.25;
        return exec("zoom-at",k==="pageup"?scale:1/scale,true);
      }
      if(s.kind==="pcb" && k==="l" && !s.interactive && !e.shiftKey)return exec("layer-controls");
      if(s.kind==="pcb" && k==="s" && e.shiftKey)return exec("layer-mode");
      if(s.kind!=="pcb" && k==="g" && e.shiftKey)return exec("grid-next",-1);
      if(e.shiftKey && k!=="+")return false;
      const choices=chords.filter(([p,,,,kind])=>p===k && (!kind||kind===s.kind));
      if(choices.length){
        e.preventDefault();
        if(!e.repeat){prefix=k;owner=s.documentId;hint(groups[k]+" · "+choices.map(([,key,,label])=>key.toUpperCase()+" "+label).join("   "));}
        return true;
      }
      const aliases={w:"route",h:"pan",l:"label",r:"rotate",f:"fit",g:s.kind==="pcb"?"grid-picker":"grid-next",q:"toggle-units","+":"zoom-in","-":"zoom-out"};
      if(s.tool==="move-object" && k==="r")return s.rotatable?exec("rotate-cw"):false;
      if(s.interactive && (k==="l"||k==="w"&&s.tool==="route"))return false;
      if(Object.hasOwn(aliases,k))return exec(aliases[k]);
      return false;
    }
    return {clear,handle};
  }
  return {create};
})();

// ------------------------------------------------------------ equivalence with the legacy handler
// The comparison runs against the "Waffle Classic" preset, which keeps the defaults from before the
// Altium chord pass whole. The Altium-faithful default preset has its own assertions further down.
const KM=AtriumKeymap;
KM.setPreset("classic");
const keys=[..."abcdefghijklmnopqrstuvwxyz0123456789",..." ?+-=\\/,.",
  "Enter","Escape","Tab","Backspace","Delete","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","PageUp","PageDown","Home","End","F1","F2","Shift","Control"];
const codeOf=k=>/^[a-z]$/.test(k)?"Key"+k.toUpperCase():/^\d$/.test(k)?"Digit"+k:({" ":"Space","\\":"Backslash","-":"Minus","=":"Equal","/":"Slash",",":"Comma",".":"Period","?":"Slash","+":"Equal"})[k]||k;
const flagSets=[{},{shiftKey:true},{ctrlKey:true},{metaKey:true},{ctrlKey:true,shiftKey:true},{metaKey:true,shiftKey:true},{altKey:true},{altKey:true,shiftKey:true},
  {ctrlKey:true,altKey:true},{metaKey:true,altKey:true},{ctrlKey:true,metaKey:true},{repeat:true},{shiftKey:true,repeat:true},{ctrlKey:true,repeat:true}];
const targets={canvas:{tagName:"CANVAS",closest:()=>null},body:{tagName:"BODY",closest:()=>null},
  button:{tagName:"BUTTON",closest:q=>/button/.test(q)&&!/input/.test(q)?{}:null},form:{tagName:"INPUT",closest:q=>/input/.test(q)?{}:null}};
const states=[];
for(const kind of ["schematic","pcb"])for(const tool of ["select","route","place","move-object","pan","via"])for(const selected of [false,true])
  for(const rotatable of [false,true])for(const target of ["canvas","body","button","form"])for(const cursorAt of tool==="select"?[false,true]:[false])
    states.push({documentId:kind,kind,tool,selected,selectionCount:selected?1:0,rotatable,cursorAt,canvas:target==="canvas",target,
      interactive:!["select","pan"].includes(tool),canProperties:kind==="pcb"&&(tool==="route"||tool==="via")});
states.push({documentId:"m",kind:"pcb",tool:"select",modal:true,canvas:true,target:"canvas"});
// New in the keymap: T starts the Tools sequence, Alt+F / Alt+Shift+F / Mod+Alt+S swap.
// Ctrl+Cmd+S in a text field is no longer Save (Ctrl+Cmd chords are never shortcuts).
// New in the keymap: L opens View Configuration on boards (as in Altium); 1/2/3 switch board planning, 2D and 3D modes.
// New in the keymap: routing keys on boards (Shift+R, 2, 3, 4, comma, period) and P I / P G.
const plain=f=>!f.ctrlKey&&!f.metaKey&&!f.altKey;
const added=(k,f,s,prefix)=>s&&s.kind==="pcb"&&!s.modal&&s.target!=="form"&&plain(f)&&(
  prefix==="p"&&!f.shiftKey&&"ig".includes(k)||!prefix&&!f.shiftKey&&(k==="l"||"123".includes(k))||s.tool==="route"&&(f.shiftKey?k==="r":!prefix&&"234,.".includes(k)));
// New: Edit » Align chords Ctrl+Shift+L/R/T/B/H/V/D with a selection.
const aligned=(k,f,s)=>s&&!s.modal&&s.target!=="form"&&(s.selected||s.selectionCount>0)&&f.ctrlKey&&f.shiftKey&&!f.metaKey&&!f.altKey&&"lrtbhvd".includes(k);
// New: PCB editing keys. L flips while placing or moving; Shift+F/H/E, Ctrl+F and V B on boards.
const pcbEditKeys=(k,f,s,prefix)=>s&&s.kind==="pcb"&&!s.modal&&s.target!=="form"&&!f.metaKey&&!f.altKey&&(
  !f.ctrlKey&&!f.shiftKey&&k==="l"&&(s.tool==="place"||s.tool==="move-object")||
  !f.ctrlKey&&f.shiftKey&&k.length===1&&"fhe".includes(k)||f.ctrlKey&&!f.shiftKey&&k==="f"||prefix==="v"&&!f.ctrlKey&&!f.shiftKey&&k==="b");
// New: F1 and Ctrl/Cmd+Shift+P open the command palette, also from text fields (Shift+F1 and ? keep the cheat sheet);
// J starts the Jump sequence (J C object, J L location); N toggles unrouted connections on boards.
const navKeys=(k,f,s,prefix)=>s&&!s.modal&&(k==="F1"&&!f.shiftKey&&!f.ctrlKey&&!f.metaKey&&!f.altKey||
  k==="p"&&f.shiftKey&&(f.ctrlKey!==f.metaKey)&&!f.altKey||s.target!=="form"&&plain(f)&&!f.shiftKey&&(k==="/"||k==="j"&&!(prefix==="p"&&s.kind==="schematic")||k==="n"&&s.kind==="pcb"&&!s.interactive));
// New: schematic place keys P O/R/C/S/A/B/U/T/F and the P V (directives) and P D (drawing tools) prefixes.
const schPlace=(k,f,s,prefix)=>s&&s.kind==="schematic"&&!s.modal&&s.target!=="form"&&plain(f)&&!f.shiftKey&&prefix==="p"&&"orcsabuvtfd".includes(k);
// New: X / Y mirror while placing on schematics (X no longer starts X A there); Mod+F finds on
// schematics, Mod+H finds and replaces, Mod+R rubber-stamps the clipboard (sch-place.js and friends).
const schPlaceKeys=(k,f,s)=>s&&!s.modal&&s.target!=="form"&&(s.kind==="schematic"&&s.interactive&&plain(f)&&!f.shiftKey&&(k==="x"||k==="y")||
  (f.ctrlKey||f.metaKey)&&!f.altKey&&!f.shiftKey&&(k==="h"||k==="r"||k==="f"&&s.kind==="schematic"));
// New: Mod+P prints (File » Print…), also over dialogs and from fields: it prints the open report (editor.js printTarget).
const printKey=(k,f,s)=>s&&k==="p"&&(f.ctrlKey!==f.metaKey)&&!f.shiftKey&&!f.altKey;
// New: board draw tools P P/F/R/L/A/E/N, P K (keepouts), P D (dimensions), D S (board shape), Ctrl+Shift+M measure primitives.
const drawKeys=(k,f,s,prefix)=>s&&s.kind==="pcb"&&!s.modal&&s.target!=="form"&&!f.metaKey&&!f.altKey&&(
  !f.ctrlKey&&!f.shiftKey&&(prefix==="p"&&"pfrlaenkd".includes(k)||prefix==="d"&&k==="s")||f.ctrlKey&&f.shiftKey&&k==="m");
// New: Shift+F finds similar objects on schematics too (sch-similar.js), as on boards.
const schSimilarKey=(k,f,s)=>s&&s.kind==="schematic"&&!s.modal&&s.target!=="form"&&plain(f)&&f.shiftKey&&k==="f";
// New: Shift+C clears the query filter (query.js), as in Altium.
const filterKeys=(k,f,s)=>s&&!s.modal&&s.target!=="form"&&plain(f)&&f.shiftKey&&k==="c";
// New: S starts the Select prefix (S L lasso select, lasso.js), as in Altium.
const selectPrefix=(k,f,s)=>s&&!s.modal&&s.target!=="form"&&plain(f)&&!f.shiftKey&&k==="s";
// New (integration): Altium Design keys D K (stack), D U (update PCB, also on schematics, so D is a schematic prefix), D C (classes).
const designKeys=(k,f,s,prefix)=>s&&!s.modal&&s.target!=="form"&&(prefix==="d"&&s.kind==="schematic"||plain(f)&&!f.shiftKey&&(prefix==="d"&&"kuc".includes(k)||!prefix&&k==="d"&&s.kind==="schematic"));
// Unified History keeps its former opt-in shortcut in every preset.
const historyKey=(k,f,s)=>s&&!s.modal&&s.target!=="form"&&k==="z"&&(f.ctrlKey!==f.metaKey)&&f.altKey&&!f.shiftKey;
// The native View menu exposes Mod+0 in Classic too.
const documentFitKey=(k,f,s)=>s&&!s.modal&&s.target!=="form"&&k==="0"&&(f.ctrlKey!==f.metaKey)&&!f.altKey&&!f.shiftKey;
const intended=(k,f,inPrefix,s,prefix)=>documentFitKey(k,f,s)||historyKey(k,f,s)||schSimilarKey(k,f,s)||designKeys(k,f,s,prefix)||selectPrefix(k,f,s)||filterKeys(k,f,s)||schPlaceKeys(k,f,s)||(prefix==="x"&&s&&s.kind==="schematic"&&s.interactive)||drawKeys(k,f,s,prefix)||printKey(k,f,s)||schPlace(k,f,s,prefix)||navKeys(k,f,s,prefix)||added(k,f,s,prefix)||aligned(k,f,s)||pcbEditKeys(k,f,s,prefix)||(k==="s"&&f.ctrlKey&&f.metaKey)||(inPrefix&&k==="+"&&!f.shiftKey&&!f.ctrlKey&&!f.metaKey&&!f.altKey)||(k==="t"&&!f.ctrlKey&&!f.metaKey&&!f.altKey&&!f.shiftKey)||
  (f.altKey&&!f.ctrlKey&&!f.metaKey&&k==="f")||(f.altKey&&(f.ctrlKey!==f.metaKey)&&!f.shiftKey&&k==="s")||
  // New (split-follow): Ctrl/⌘+Alt+\ opens the schematic | board split (split-counterpart); the legacy handler ignored Alt chords.
  (f.altKey&&(f.ctrlKey!==f.metaKey)&&!f.shiftKey&&k==="\\");
function event(k,f,target){
  const key=f.shiftKey&&/^[a-z]$/.test(k)?k.toUpperCase():k;
  return {key,code:codeOf(k),target:targets[target],...f,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
}
function trial(factory,seq,s){
  const out=[],hints=[];const h=factory((a,p)=>out.push(p==null?a:a+":"+JSON.stringify(p)),v=>hints.push(v));
  const res=[];for(const [k,f] of seq){const e=event(k,f,s.target);res.push(h.handle(e,s)+"/"+e.defaultPrevented);}
  return {out:out.join(","),res:res.join(","),hint:hints.find(Boolean)||""};
}
let compared=0,mismatches=[];
function compare(seq,s){
  const a=trial(legacy.create,seq,s),b=trial(AtriumEditorKeys.create,seq,s);compared++;
  // The board Place hint gains the new P I and P G entries at its end.
  const hintOk=a.hint===b.hint||(s.kind==="schematic"&&!!a.hint&&b.hint.startsWith(a.hint))||(a.hint&&b.hint===a.hint+"   I Differential pair   G Polygon pour")||(a.hint&&b.hint===a.hint+"   B Flip board")||
    // Board P and D hints gain the draw-tool entries (pcb-draw.js); every legacy entry stays.
    (s.kind==="pcb"&&!!a.hint&&b.hint.startsWith(a.hint.split(" · ")[0]+" · ")&&a.hint.split(" · ")[1].split("   ").every(x=>b.hint.includes(x)));
  if(a.out!==b.out||a.res!==b.res||!hintOk)mismatches.push({seq:seq.map(([k,f])=>JSON.stringify(f)+k).join(" "),state:JSON.stringify(s),legacy:a,keymap:b});
}
for(const s of states)for(const k of keys)for(const f of flagSets){
  if(intended(k,f,false,s))continue;
  compare([[k,f]],s);
}
// Sequences: every prefix letter followed by every key and modifier set.
for(const s of states.filter(s=>s.target!=="form"&&!s.modal))for(const p of "pvmxd")for(const k of keys)for(const f of flagSets){
  // Numpad + (no Shift) during a sequence now falls through to Zoom in like Shift+= does.
  if(intended(k,f,true,s,p))continue;
  // A shifted key during a prefix falls through and keeps the prefix in both; the keymap then clears it on a command.
  compare([[p,{}],[k,f]],s);
}
if(mismatches.length){console.log(JSON.stringify(mismatches.slice(0,8),null,1));}
assert.equal(mismatches.length,0,mismatches.length+" of "+compared+" key cases differ from the legacy handler");
console.log("PASS Waffle Classic reproduces the legacy handler on "+compared+" single keys and two-key sequences across "+states.length+" editor states.");
KM.setPreset("altium");

// ------------------------------------------------------------ Altium-faithful default preset
{
  const P={kind:"pcb",tool:"select",canvas:true},S={kind:"schematic",tool:"select",canvas:true},sel={selected:true,selectionCount:2};
  const routing={...P,tool:"route",interactive:true,canProperties:true},placing={...P,tool:"place",interactive:true,rotatable:true};
  const want=[
    // R is the Reports prefix; rotation stays on Space.
    ["R",P,"prefix"],["R",S,"prefix"],["R M",P,"measure"],["R M",S,"measure"],["R P",P,"measure-primitives"],["R S",P,"measure-selected"],["R B",S,"bom"],["R P",S,null],
    ["Space",{...P,rotatable:true},"rotate-ccw"],["Shift+Space",placing,"rotate-cw"],["Space",{...P,tool:"move-object",interactive:true,rotatable:true},"rotate-ccw"],
    // Layers: + / − / * on boards (numpad and plain); schematics still zoom with + / −; PgUp/PgDn zoom.
    ["+",P,"layer-next"],["-",P,"layer-prev"],["*",P,"layer-signal-next"],["+",routing,"layer-next"],["*",routing,"layer-signal-next"],
    ["+",S,"zoom-in"],["-",S,"zoom-out"],["PageUp",P,"zoom-in-pointer"],["PageDown",P,"zoom-out-pointer"],
    // Routing presets.
    ["Shift+W",routing,"route-width-pick"],["Shift+V",routing,"route-via-pick"],["Shift+W",P,null],["3",routing,"route-width"],
    // Connected copper, find and replace, duplicate.
    ["Ctrl+H",P,"select-net"],["Ctrl+H",S,"find-replace"],["Mod+Shift+F",P,"find-replace"],["Mod+Shift+F",S,"find-replace"],
    ["Mod+D",P,"duplicate"],["Ctrl+D",P,"duplicate"],["Meta+D",P,"duplicate"],["Mod+D",S,"duplicate"],
    // E, S, M, A, C and U prefixes.
    ["E",P,"prefix"],["E D",P,"delete-pick"],["E D",S,"delete-pick"],["E S",P,"prefix"],["E S I",P,"select-inside"],["E S O",S,"select-outside"],["E S N",P,"select-net"],
    ["E S L",P,"lasso-select"],["E M",P,"prefix"],["E M M",P,"move-object"],["E M S",P,"move-selection"],["E M D",S,"drag-object"],
    ["S I",P,"select-inside"],["S O",P,"select-outside"],["S N",P,"select-net"],["S N",S,"select-net"],["S L",P,"lasso-select"],["S A",S,"select-all"],
    ["M M",P,"move-object"],["M S",P,"move-selection"],["M D",P,"drag-object"],
    ["A",S,"prefix"],["A L",{...S,...sel},"align-left"],["A R",S,"align-right"],["A T",P,"align-top"],["A B",P,"align-bottom"],["A C",S,"align-hcenter"],
    ["A V",S,"align-vcenter"],["A D",S,"distribute-h"],["A I",S,"distribute-v"],["A G",P,"align-grid"],["A A",P,"autoroute-all"],["A F",P,"fanout"],["A A",S,"align-dialog"],
    // Altium chords part 2: S T / S C / S P, E G …, U A M, Shift+Space and Tab while moving, pane focus (Mod+1…9 are selection memory).
    ["S T",P,"select-touching"],["S T",S,"select-touching"],["S C",P,"select-connection"],["S C",S,null],["S P",P,"select-physical"],["E S T",S,"select-touching"],["E S P",P,"select-physical"],
    ["E G",P,"prefix"],["E G A",S,"align-dialog"],["E G A",P,"align-dialog"],["E G L",P,"align-left"],["E G I",S,"distribute-v"],["E G G",P,"align-grid"],["U A M",P,"autoroute-room"],["U A M",S,null],
    ["Shift+Space",{...P,dragging:true},"move-corner-mode"],["Shift+Space",{...P,sticky:true},"move-corner-mode"],["Tab",{...P,sticky:true},"move-properties"],["Tab",{...S,dragging:true},"move-properties"],
    ["Shift+Space",placing,"rotate-cw"],["Tab",routing,"tool-properties"],
    ["F6",P,"focus-part-next"],["Shift+F6",S,"focus-part-prev"],["Mod+K Z",P,"zen-mode"],["Mod+K Right",P,"focus-pane-next"],["Mod+K Left",S,"focus-pane-prev"],["Mod+1",P,"selmem-store-1"],["Mod+2",S,"selmem-store-2"],["Alt+3",P,"selmem-recall-3"],["J 4",S,"camera-recall-4"],["1",P,"view-planning"],
    ["C C",S,"compile"],["C C",P,"compile"],
    ["U",P,"prefix"],["U",S,null],["U T",P,"route"],["U I",P,"route-diffpair"],["U R",P,"length-tune"],["U A A",P,"autoroute-all"],["U A F",P,"fanout"],
    ["U U A",P,"unroute-all"],["U U N",P,"delete-net-copper"],["U U C",P,"unroute-connection"],["U U O",P,"unroute-component"],["U U R",P,"unroute-room"],
    // One macOS rule: Mod (⌘ or Ctrl) wherever Altium uses Ctrl, except ⌃W, ⌃M, ⌃H, which macOS keeps.
    ["Meta+F",P,"find"],["Ctrl+F",P,"find"],["Meta+F",S,"find"],["Meta+Shift+L",{...P,...sel},"align-left"],["Ctrl+Shift+L",{...P,...sel},"align-left"],
    ["Meta+Shift+M",P,"measure-primitives"],["Meta+Left",{...P,...sel},"nudge-left"],["Meta+Shift+G",S,"grid"],
    ["Ctrl+W",P,"route"],["Meta+W",P,null],["Ctrl+M",P,"measure"],["Meta+M",P,null],["Meta+H",P,null],
    // Unchanged Altium keys.
    ["P T",P,"route"],["P W",S,"route"],["T D",P,"drc"],["D R",P,"rules"],["Shift+C",P,"query-clear"],["Shift+C",S,"query-clear"],["X A",P,"deselect"],["L",P,"view-config"]
  ];
  for(const [k,s,id] of want)assert.equal(KM.resolve(k,s),id,"Altium preset: "+k+" on "+s.kind+(s.tool!=="select"?" ("+s.tool+")":""));
  KM.setPlatform(false);assert.equal(KM.hintFor("duplicate","pcb"),"Ctrl+D");assert.equal(KM.hintFor("select-net","pcb"),"Ctrl+H");
  KM.setPlatform(true);assert.equal(KM.hintFor("duplicate","pcb"),"⌘D");assert.equal(KM.hintFor("measure","pcb"),"⌃M");assert.equal(KM.hintFor("flip-board","pcb"),"V, B");KM.setPlatform(false);
  // Status-bar hints name the new prefixes.
  const hk=[],hh=AtriumEditorKeys.create(()=>{},t=>hk.push(t));
  for(const [k,s,re] of [["r",P,/^Reports · M Measure distance   P Measure primitives   S Measure selected objects   B Bill of materials$/],["u",P,/^Route · .*A Auto Route….*U Un-Route…/],
    ["e",P,/^Edit · D Delete   S Select…   M Move…   G Align…$/],["a",S,/^Align · L Left/],["c",S,/^Project · C Compile   M Annotate \(comment mode\)$/]]){
    hh.handle(event(k,{},"canvas"),{...s,documentId:"h"+k});assert.match(hk.at(-1),re);hh.clear();
  }
  // The classic preset keeps R rotate, + zoom and Ctrl+D layer controls; KiCad builds on it.
  KM.setPreset("classic");
  assert.equal(KM.resolve("R",P),"rotate");assert.equal(KM.resolve("+",P),"zoom-in");assert.equal(KM.resolve("Ctrl+D",P),"layer-controls");assert.equal(KM.resolve("E D",P),null);
  KM.setPreset("kicad");assert.equal(KM.resolve("R",P),"rotate","KiCad keeps bare R");assert.equal(KM.resolve("A",P),"library");
  KM.setPreset("vscode");assert.equal(KM.resolve("+",P),"layer-next");assert.equal(KM.resolve("+",S),"zoom-in");
  KM.setPreset("altium");
  console.log("PASS Altium-faithful default preset: "+want.length+" chords (R reports, layers, E/S/M/A/C/U, Ctrl+H, Ctrl+D, Shift+W/V, ⌘ rule).");
}

// Shared groups: Classic projects one Altium ordering for both editors and a live route. Ctrl+M stays preset-owned.
{
  const sch={kind:"schematic",tool:"select",canvas:true},pcb={kind:"pcb",tool:"select",canvas:true},route={...pcb,tool:"route",interactive:true},schRoute={...sch,tool:"route",interactive:true},rot={...pcb,tool:"place",interactive:true,rotatable:true};
  const rows=[["P W",sch,"route"],["P T",pcb,"route"],["P T",sch,"sch-text"],["V D",sch,"fit-document"],["Mod+PageDown",pcb,"fit-document"],["Mod+PageDown",sch,"fit-objects"],["T R",pcb,"length-tune"],["T D",sch,"drc"],["Space",route,"route-bend"],["Space",rot,"rotate-ccw"],["Space",pcb,"pan-hold"],["4",route,"route-via-size"],["Backspace",route,"route-back"],["Delete",{...pcb,selected:true,selectionCount:1},"delete"],["PageUp",sch,"zoom-in-pointer"],["Shift+F1",sch,"shortcuts"]];
  const G=KM.sharedGroups;assert.deepEqual([G.placementPrefix,G.schematicView,G.tunePourSwap,G.toolsDesign,G.fitSplit,G.swapHelp,G.escapeToolTune,G.liveRoute,G.deleteZoom].map(g=>g.length),[25,22,7,7,4,5,18,3,10]);
  for(const preset of ["altium","classic"]){KM.setPreset(preset);for(const [k,s,id] of rows)assert.equal(KM.resolve(k,s),id,preset+" "+k);}
  KM.setPreset("altium");assert.equal(KM.resolve("Ctrl+M",route),"measure");assert.equal(KM.resolve("Ctrl+W",schRoute),"start-wire");assert.equal(KM.resolve("R M",route),"measure");
  KM.setPreset("classic");assert.equal(KM.resolve("Ctrl+M",schRoute),"measure");assert.equal(KM.resolve("Ctrl+W",schRoute),"keep-routing");assert.equal(KM.resolve("R M",route),null);
}

// ------------------------------------------------------------ tables, conflicts, sequence trie
KM.useStorage(memory());
assert.deepEqual(KM.conflicts(),[],"default bindings have no conflicts");
for(const p of KM.presets()){
  KM.setPreset(p.id);
  assert.deepEqual(KM.conflicts().map(c=>c.message),[],p.id+" preset has no conflicts");
  assert.equal(KM.resolve("Mod+Alt+Z",{kind:"pcb",tool:"select",canvas:true}),"history",p.id+" retains the History shortcut");
}
KM.setPreset("altium");
const sch={kind:"schematic",tool:"select",canvas:true},pcb={kind:"pcb",tool:"select",canvas:true};
assert.equal(KM.resolve("P",sch),"prefix");assert.equal(KM.resolve("P W",sch),"route");assert.equal(KM.resolve("P T",pcb),"route");
assert.equal(KM.resolve("P T",sch),"sch-text");assert.equal(KM.resolve("P O",sch),"sch-power");assert.equal(KM.resolve("P V N",sch),"sch-noerc");
assert.equal(KM.resolve("P D L",sch),"sch-line");assert.equal(KM.resolve("P V",pcb),"via");assert.equal(KM.resolve("P S",sch),"sch-sheet-symbol");assert.equal(KM.resolve("P S",pcb),"label");assert.equal(KM.resolve("D U",sch),"eco","D U updates the PCB from a schematic (Altium Design » Update PCB Document)");assert.equal(KM.resolve("D R",sch),"rules","D R opens the Rules and Constraints Editor from either editor");
assert.equal(KM.resolve("T W",pcb),"prefix");assert.equal(KM.resolve("T W S",pcb),"swap-components");
assert.equal(KM.resolve("Ctrl+Alt+S",pcb),"swap-components");assert.equal(KM.resolve("Meta+Alt+S",pcb),"swap-components");
assert.equal(KM.resolve("Alt+F",{...pcb,selected:true}),"swap-variant");
assert.equal(KM.resolve("Space",{...pcb,tool:"route",interactive:true}),"route-bend");
assert.equal(KM.resolve("Space",{...pcb,rotatable:true}),"rotate-ccw");assert.equal(KM.resolve("Space",pcb),"pan-hold");
assert.equal(KM.resolve("Mod+S",sch),"save");assert.equal(KM.resolve("Ctrl+Shift+Z",sch),"redo");
assert.equal(KM.normalize("ctrl+shift+s"),"Ctrl+Shift+S");assert.equal(KM.normalize("Shift+?"),"?");assert.equal(KM.normalize("p, w"),"P W");
assert.equal(KM.normalize("Cmd+Option+F"),"Alt+Meta+F");assert.equal(KM.normalize("Mod++"),"Mod++");
assert.throws(()=>KM.parse("Hyper+Q"),/modifier/);assert.throws(()=>KM.parse("Ctrl+Nope"),/Unknown key/);
assert.equal(KM.display("Mod+Shift+Z"),"Ctrl+Shift+Z");assert.equal(KM.display("P W"),"P, W");
KM.setPlatform(true);assert.equal(KM.display("Mod+Shift+Z"),"⇧⌘Z");assert.equal(KM.display("Ctrl+M"),"⌃M");assert.equal(KM.display("Mod+Alt+S",true),"Option+Command+S");KM.setPlatform(false);
// Hints and menus follow the live map.
assert.equal(KM.hintFor("route","pcb"),"P, T");assert.equal(KM.hintFor("route","schematic"),"P, W");assert.equal(KM.hintFor("rules","schematic"),"D, R");
assert.equal(KM.hintFor("undo","pcb"),"Ctrl+Z");assert.equal(KM.hintFor("shortcuts","pcb"),"Shift+F1");assert.equal(KM.hintFor("swap-components","pcb"),"T, W, S");
// Length tuning: T R / T I on boards; session keys only while a tuning session is live.
assert.equal(KM.resolve("T R",pcb),"length-tune");assert.equal(KM.resolve("T I",pcb),"length-tune-pair");assert.equal(KM.resolve("T R",sch),null);
const tuning={...pcb,tool:"length-tune",interactive:true,tuning:true};
for(const [k,p] of [["1","1"],["2","2"],["3","3"],["4","4"],[",",","],[".","."],["Tab","Tab"]]){
  const ev=[],hk=AtriumEditorKeys.create((a,q)=>ev.push([a,q]),()=>{}),e=event(k==="Tab"?"Tab":k,{},"canvas");
  hk.handle(e,{...tuning,documentId:"b"});assert.deepEqual(ev,[["length-key",p]]);assert.equal(e.defaultPrevented,true);
}
assert.equal(KM.resolve("1",{...tuning,tuning:false}),null);
const routingPcb={...pcb,tool:"route",interactive:true,canProperties:true};
for(const [k,id] of [["Shift+R","route-conflict"],["*","layer-signal-next"/* Altium: * at any time on boards */],["2","route-via"],["3","route-width"],["4","route-via-size"],[".","route-arc-larger"],[",","route-arc-smaller"]])
  assert.equal(KM.resolve(k,routingPcb),id);
assert.equal(KM.resolve("Space",{...pcb,tool:"route-diffpair",interactive:true}),"route-bend","diff pair routing is routing");
assert.equal(KM.resolve("P I",pcb),"route-diffpair");assert.equal(KM.resolve("T G A",pcb),"repour");assert.equal(KM.resolve("3",sch),null);assert.equal(KM.resolve("Tab",{...pcb,tool:"route",interactive:true,canProperties:true}),"tool-properties");
// When expressions.
const w=KM.compileWhen("pcb && selection.count >= 2 && tool != route || (schematic && !placing)");
assert.equal(w({kind:"pcb",selectionCount:2,tool:"select"}),true);assert.equal(w({kind:"pcb",selectionCount:1,tool:"select"}),false);
assert.equal(w({kind:"pcb",selectionCount:3,tool:"route"}),false);assert.equal(w({kind:"schematic",interactive:false}),true);
assert.equal(KM.compileWhen("myExt.enabled")({myExt:{enabled:true}}),true);assert.throws(()=>KM.compileWhen("pcb &&"),/ends early/);

// ------------------------------------------------------------ override precedence
KM.setBindings("toggle-units",[{key:"Alt+U"}]);
assert.equal(KM.resolve("Alt+U",sch),"toggle-units");assert.equal(KM.resolve("Q",sch),null,"user list replaces the defaults");
KM.setPreset("kicad");assert.equal(KM.resolve("Alt+U",sch),"toggle-units","user overrides apply over the preset");
assert.equal(KM.resolve("X",pcb),"route");assert.equal(KM.resolve("A",pcb),"library");assert.equal(KM.resolve("M",pcb),"move-object");
assert.equal(KM.resolve("P W",sch),"route","Altium sequences the preset leaves alone remain");
KM.resetCommand("toggle-units");assert.equal(KM.resolve("Mod+U",sch),"toggle-units","reset falls back to the preset");
KM.setPreset("vscode");assert.equal(KM.resolve("Mod+K",sch),"prefix");assert.equal(KM.resolve("Mod+K Mod+S",sch),"keyboard-shortcuts");
assert.equal(KM.resolve("Mod+B",sch),"toggle-left");assert.equal(KM.resolve("Q",sch),"toggle-units","VS Code preset keeps editor bindings");
KM.setPreset("altium");
// ------------------------------------------------------------ VS Code keys (docs/shortcuts.md "VS Code keys")
{
  const sel={...pcb,selected:true,selectionCount:1},route={...pcb,tool:"route",interactive:true};
  // The default keeps Altium meanings and adds the VS Code keys that clash with nothing.
  for(const [k,s,id] of [["Mod+Shift+P",sch,"command-palette"],["Mod+P",pcb,"quick-open"],["Mod+G",pcb,"grid-custom"],["Ctrl+W",pcb,"route"],["Mod+Shift+T",sel,"align-top"],
    ["Mod+Shift+M",pcb,"measure-primitives"],["Mod+PageDown",pcb,"fit-document"],
    ["Mod+B",pcb,"toggle-left"],["Mod+Alt+B",sch,"toggle-right"],["Mod+J",pcb,"messages"],["Mod+K Mod+S",pcb,"keyboard-shortcuts"],["Mod+K Mod+T",sch,"theme-picker"],
    ["Mod+K Z",pcb,"zen-mode"],["Mod+Shift+O",pcb,"goto-object"],["Mod+Shift+E",sch,"focus-projects"],["Mod+Shift+X",pcb,"focus-extensions"],["Mod+Shift+F",pcb,"find-replace"],
    ["Ctrl+Tab",pcb,"doc-next"],["Ctrl+Shift+Tab",sch,"doc-prev"],["Mod+Alt+Right",pcb,"doc-next"],["Mod+F4",pcb,"close-document"],["F2",sel,"rename-object"],
    ["Mod+=",sch,"zoom-in"],["Mod+-",pcb,"zoom-out"],["Mod+0",pcb,"fit-document"],["Mod+N",sch,"new"],["Ctrl+`",pcb,"toggle-console"],["Mod+?",pcb,"cheatsheet"],["Mod+Shift+/",sch,"cheatsheet"],
    ["Mod+1",sel,"selmem-store-1"],["Mod+9",sel,"selmem-store-9"]])assert.equal(KM.resolve(k,s),id,"default: "+k);
  assert.equal(KM.resolve("F2",{...pcb,tool:"place",interactive:true}),null,"F2 is free while placing");
  // The VS Code-like preset takes VS Code meanings everywhere.
  KM.setPreset("vscode");
  for(const [k,s,id] of [["Mod+P",pcb,"quick-open"],["Mod+E",sch,"quick-open"],["Mod+G",pcb,"goto-location"],["Mod+Shift+O",sch,"goto-object"],["Mod+T",pcb,"goto-object"],
    ["Mod+F",pcb,"find"],["Mod+F",sch,"find"],["Ctrl+W",pcb,"close-document"],["Ctrl+W",route,"keep-routing"],["Mod+F4",sch,"close-document"],
    ["Mod+Shift+T",sel,"reopen-document"],["A T",sel,"align-top"],["Mod+J",pcb,"messages"],["Mod+Shift+M",pcb,"messages"],["R P",pcb,"measure-primitives"],
    ["Mod+PageDown",pcb,"doc-next"],["Mod+PageUp",sch,"doc-prev"],["V D",pcb,"fit-document"],["V B",pcb,"flip-board"],["Mod+Alt+F",pcb,"find-replace"],
    ["Ctrl+H",pcb,"select-net"],["P T",pcb,"route"],["W",pcb,"route"],["J L",pcb,"goto-location"],["Mod+B",sch,"toggle-left"],["Mod+?",pcb,"cheatsheet"],
    ["Mod+1",sel,"selmem-store-1"],["Mod+K Mod+T",pcb,"theme-picker"],["+",pcb,"layer-next"],["Q",sch,"toggle-units"]])assert.equal(KM.resolve(k,s),id,"VS Code preset: "+k);
  assert.equal(KM.resolve("Mod+P",{...pcb}),"quick-open");assert.deepEqual(KM.bindingsFor("print"),[],"print stays on File › Print…");
  KM.setPlatform(true);assert.equal(KM.resolve("Meta+W",pcb),"close-document","⌘W closes the document in the VS Code preset");assert.deepEqual(KM.conflicts(),[]);KM.setPlatform(false);
  for(const p of ["altium","kicad","vscode","rts"]){KM.setPreset(p);assert.ok(KM.resolve("Mod+?",pcb)==="cheatsheet","cheat sheet key in "+p);}
  const D=globalThis.AtriumKeymapPresets.vscodeDecisions;assert.ok(D.length>=30&&D.every(r=>r.length===5),"every VS Code key decision is documented");
  KM.setPreset("altium");
}
// ------------------------------------------------------------ Allegro-like and Modern (Mac) presets
{
  const KP=globalThis.AtriumKeymapPresets,P={kind:"pcb",tool:"select",canvas:true},S={kind:"schematic",tool:"select",canvas:true};
  const routing={...P,tool:"route",interactive:true,canProperties:true},placing={...P,tool:"place",interactive:true,rotatable:true};
  const sel={...P,selected:true,selectionCount:1},schPlacing={...S,tool:"place",interactive:true,rotatable:true};
  // Zero conflicts on PC and Mac; every binding parses; every bound action exists.
  for(const id of ["allegro","modern"]){
    KM.setPreset(id);assert.equal(KM.preset(),id);
    for(const mac of [false,true]){KM.setPlatform(mac);assert.deepEqual(KM.conflicts().map(c=>c.message),[],id+" has no conflicts ("+(mac?"Mac":"PC")+")");}
    KM.setPlatform(false);assert.deepEqual(KM.table().errors,[],id+": every binding parses");
    assert.equal(KM.resolve("Mod+?",P),"cheatsheet","cheat sheet key in "+id);
  }
  for(const [keys,cid] of KP.modern)assert.ok(KM.command(cid),"Modern binds a real command: "+cid+" ("+keys+")");
  for(const cid of Object.keys(KP.allegro))assert.ok(KM.command(cid),"preset binds a real command: "+cid);
  for(const [cid] of KP.newCommands)assert.ok(KM.command(cid),"preset command registered: "+cid);
  // Allegro F-key semantics.
  KM.setPreset("allegro");
  for(const [k,s,id] of [["F2",P,"fit"],["F3",P,"route"],["F3",S,"route"],["F4",P,"toggle-right"],["F5",P,null],
    ["F6",P,"escape-done"],["F6",routing,"escape-done"],["F6",placing,"escape-done"],
    ["F7",routing,"route-back"],["F7",P,"undo"],["F7",S,"undo"],
    ["F8",routing,"escape-cancel"],["F9",routing,"escape-cancel"],["F8",placing,"escape-cancel"],["F9",S,"escape-cancel"],
    ["F10",P,"grid"],["F11",P,"zoom-in"],["F12",S,"zoom-out"],["Mod+F4",P,"close-document"],
    ["X",P,"command-bar"],["X",routing,"command-bar"],["X",placing,"command-bar"],["X",S,"command-bar"],["X",schPlacing,"mirror-x"],["X A",P,null],
    ["Ctrl+R",placing,"rotate-ccw"],["Ctrl+R",P,"rubber-stamp"],["Meta+R",P,"rubber-stamp"],["Mod+Shift+A",P,"deselect"],
    // The Altium-style default underneath stays.
    ["P T",P,"route"],["T D",P,"drc"],["Backspace",routing,"route-back"],["Escape",routing,"escape"],["Mod+K Mod+T",P,"theme-picker"]])
    assert.equal(KM.resolve(k,s),id,"Allegro preset: "+k+" on "+s.kind+(s.tool!=="select"?" ("+s.tool+")":""));
  assert.equal(KM.hintFor("escape-done","pcb"),"F6");assert.equal(KM.hintFor("escape-cancel","pcb"),"F8");
  const D=KP.allegroDecisions;assert.ok(D.length>=15&&D.every(r=>r.length===5),"every Allegro mapping is documented");
  for(const f of ["F2","F3","F4","F5","F6","F7","F8, F9","F10","F11, F12"])assert.ok(D.some(r=>r[0]===f),"Allegro "+f+" is documented");
  // Modern (Mac): macOS conventions, Figma tool letters, ⌘K palette with ⌘K chords, no Altium sequences.
  KM.setPreset("modern");
  const tuning={...P,tool:"length-tune",interactive:true,tuning:true},dragging={...P,dragging:true,selected:true,selectionCount:1};
  for(const [k,s,id] of [["Mod+S",P,"save"],["Mod+Shift+S",P,"save-as"],["Mod+Z",S,"undo"],["Mod+Shift+Z",P,"redo"],["Mod+C",P,"copy"],["Mod+X",P,"cut"],["Mod+V",P,"paste"],
    ["Mod+A",P,"select-all"],["Mod+F",S,"find"],["Mod+F",P,"find"],["Mod+G",sel,"union-create"],["Mod+W",P,"close-document"],["Mod+W",placing,"close-document"],["Mod+W",routing,"close-document"],["Mod+W",sel,"close-document"],["Mod+W",dragging,"close-document"],["Mod+N",P,"new"],["Mod+O",P,"open"],
    ["Mod+P",P,"print"],["Mod+K",P,"prefix"],["Mod+K Mod+T",P,"theme-picker"],["Mod+K Mod+S",S,"keyboard-shortcuts"],["Mod+Shift+P",P,"command-palette"],
    ["Mod+1",P,"doc-tab-1"],["Mod+9",S,"doc-tab-9"],["Mod+[",P,"view-back"],["Mod+]",P,"view-forward"],["Mod+=",P,"zoom-in"],["Mod+-",P,"zoom-out"],["Mod+0",P,"fit-document"],
    ["Mod+Shift+F",P,"find-replace"],["Mod+J",P,"messages"],["Mod+B",P,"toggle-left"],["Mod+Alt+I",P,"toggle-right"],["Mod+D",sel,"duplicate"],["Mod+E",sel,"find-similar"],
    ["Mod+L",P,"goto-location"],["Mod+L",routing,"command-bar"],["Mod+L",placing,"command-bar"],
    ["R",P,"route"],["R",sel,"route"],["R",placing,"rotate-ccw"],["Shift+R",placing,"rotate-cw"],["Shift+R",routing,"route-conflict"],["V",P,"select"],["V",routing,"route-via"],
    ["P",P,"library"],["W",S,"route"],["W",routing,"route-width-pick"],["N",S,"label"],["T",S,"sch-text"],["T",P,"label"],["M",P,"measure"],["M",routing,"route-mode"],
    ["L",P,"view-config"],["H",P,"pan"],["Space",P,"pan-hold"],["Space",routing,"pan-hold"],["Space",placing,"pan-hold"],["Shift+Space",routing,"route-bend"],
    ["Left",sel,"nudge-left"],["Left",placing,"cursor-left"],["Left",P,"camera-pan-left"],["Alt+A",sel,"align-left"],["]",P,"layer-next"],["]",tuning,"length-rounding-up"],
    ["Escape",routing,"escape"],["Backspace",routing,"route-back"],["Backspace",sel,"delete"],["Shift+Space",dragging,"move-corner-mode"],
    // No Altium sequences or Ctrl-isms.
    ["P T",P,null],["T D",P,null],["X A",P,null],["Ctrl+W",P,"close-document"],["Ctrl+M",P,null],["Ctrl+H",P,null],["F8",P,null]])
    assert.equal(KM.resolve(k,s),id,"Modern preset: "+k+" on "+s.kind+(s.tool!=="select"?" ("+s.tool+")":""));
  // ⌘W is bound in every context on a Mac, so it never falls through to the window's Close (which quits).
  KM.setPlatform(true);
  for(const s of [P,S,sel,placing,routing,tuning,dragging])assert.equal(KM.resolve("Meta+W",s),"close-document","Modern preset: ⌘W closes the tab ("+s.kind+(s.tool!=="select"?", "+s.tool:"")+")");
  KM.setPlatform(false);
  // ⌘K is a prefix whose lead opens the palette at once (editor-keys.js), and menus show ⌘K for the palette.
  const t=KM.table(),mk=t.root.get(KM.parse("Meta+K")[0].key*16+KM.META);
  assert.equal(KM.leadOf(mk,P,true)?.id,"command-palette");assert.ok(KM.isPrefix(mk,P,true));
  KM.setPlatform(true);assert.equal(KM.hintFor("command-palette","pcb"),"⌘K");assert.equal(KM.hintFor("route","pcb"),"R");KM.setPlatform(false);
  {
    const ev=[],hk=AtriumEditorKeys.create((a,q)=>ev.push(a),()=>{});
    hk.handle(event("k",{metaKey:true},"canvas"),{...P,documentId:"lead"});assert.deepEqual(ev,["command-palette"],"⌘K opens the palette at once");
    hk.handle(event("t",{metaKey:true},"canvas"),{...P,documentId:"lead"});assert.deepEqual(ev,["command-palette","theme-picker"],"⌘K ⌘T still runs the chord");
  }
  // No two-key Altium sequences: every sequence starts with ⌘K.
  for(const rec of t.all)if(rec.key.includes(" "))assert.match(rec.key,/^Mod\+K /,"Modern has only ⌘K chords: "+rec.key+" ("+rec.id+")");
  // The macOS reserved shortcuts are never bound, at any position of any binding (Mod expands to ⌘ and Ctrl).
  const reserved=new Set(KP.macReserved.map(x=>{const c=KM.parse(x)[0];return c.key*16+c.mods;}));
  assert.ok(reserved.size>=20);
  for(const rec of t.all)for(const seq of rec.seqs)for(const code of seq)assert.ok(!reserved.has(code),"Modern binds a macOS reserved key: "+rec.key+" ("+rec.id+")");
  for(const x of ["Meta+H","Meta+M","Meta+Q","Meta+Tab","Meta+Space","Ctrl+Meta+F","Alt+Meta+Escape","Meta+`"])assert.ok(KP.macReserved.includes(x),x+" is on the reserved list");
  // Every Modern binding has a documented reason (docs/keymap-modern-mac.md).
  for(const [keys,cid] of KP.modern){const k=KM.normalize(keys);assert.ok(KP.modernWhy[k],"Modern "+k+" ("+cid+") has a reason");}
  KM.setPreset("altium");
}
// Conflicts and shadowing.
KM.setBindings("toggle-units",[{key:"Mod+Z"}]);
let c=KM.conflicts();assert.equal(c.length,1);assert.equal(c[0].type,"conflict");assert.match(c[0].message,/Undo/);
assert.equal(KM.resolve("Mod+Z",sch),"toggle-units","a user binding wins its conflict");
KM.setBindings("toggle-units",[{key:"Mod+Z",when:"pcb"}]);assert.equal(KM.conflicts().length,1);assert.equal(KM.resolve("Mod+Z",sch),"undo");
KM.setBindings("toggle-units",[{key:"P"}]);c=KM.conflicts();assert.equal(c.length,26+15/*pcb-draw P sequences*/);assert.ok(c.every(x=>x.type==="shadow"));
assert.equal(KM.resolve("P",sch),"prefix","the sequence prefix hides the single key");
KM.setBindings("toggle-units",[{key:"D"}]);assert.equal(KM.resolve("D",sch),"prefix","D U (Update PCB Document) makes D a prefix in schematics too");
assert.equal(KM.conflicts().length,5/*D R, D S E, D K, D U, D C*/);
KM.resetAll();assert.deepEqual(KM.conflicts(),[]);

// ------------------------------------------------------------ persistence, import and export
const store=memory();KM.useStorage(store);
KM.setPreset("kicad");KM.addBinding("swap-components","Alt+W");KM.removeBinding("measure",0);
const saved=JSON.parse(store.getItem("atrium-keymap-v1"));
assert.equal(saved.preset,"kicad");assert.deepEqual(saved.bindings["swap-components"],[{key:"Alt+S"},{key:"Mod+Alt+S"},{key:"Alt+W"}]);
assert.deepEqual(saved.bindings.measure,[]);
KM.useStorage(memory());assert.equal(KM.preset(),"altium");assert.equal(KM.resolve("Alt+W",pcb),null);
KM.useStorage(store);assert.equal(KM.preset(),"kicad");assert.equal(KM.resolve("Alt+W",pcb),"swap-components");
const text=KM.exportJSON();KM.useStorage(memory());
const problems=KM.importJSON(JSON.stringify({...JSON.parse(text),bindings:{...JSON.parse(text).bindings,undo:[{key:"Ctrl+Bogus"},{key:"Mod+U",when:"pcb &&"}]}}));
assert.equal(problems.length,2);assert.equal(KM.resolve("Alt+W",pcb),"swap-components");
assert.deepEqual(KM.bindingsFor("undo"),[{key:"Mod+Z",when:"",source:"default"}],"rejected rows leave the preset binding in effect");
assert.equal(KM.resolve("Mod+Z",sch),"undo");
assert.equal(Object.hasOwn(JSON.parse(KM.exportJSON()).bindings,"undo"),false,"a rejected override is never saved as an unbind");
assert.deepEqual(KM.importJSON({...JSON.parse(text),bindings:{...JSON.parse(text).bindings,undo:[]}}),[]);
assert.deepEqual(KM.bindingsFor("undo"),[],"an explicit empty list still clears the binding");
assert.equal(KM.resolve("Mod+Z",sch),null);
assert.throws(()=>KM.importJSON("[1]"),/not a Waffle key map/);
KM.useStorage({getItem(){throw Error("blocked");},setItem(){throw Error("blocked");}});KM.setPreset("vscode");assert.equal(KM.preset(),"vscode","storage failures are ignored");
KM.useStorage(memory());

// ------------------------------------------------------------ extension commands
let ran=0;const reg=KM.registerCommand({id:"ext.hello",title:"Say hello",defaultKeys:"Alt+H",when:"pcb",run:()=>ran++});
assert.equal(KM.resolve("Alt+H",pcb),"ext.hello");assert.equal(KM.resolve("Alt+H",sch),null);
const h=AtriumEditorKeys.create(()=>{throw Error("extension commands run themselves");},()=>{});
h.handle(event("h",{altKey:true},"canvas"),{...pcb,documentId:"b"});assert.equal(ran,1);
assert.throws(()=>KM.registerCommand({id:"undo"}),/built in/);
reg.dispose();assert.equal(KM.resolve("Alt+H",pcb),null);

// ------------------------------------------------------------ no allocation on the hot path (structural)
const t1=KM.table();assert.equal(KM.table(),t1,"the compiled table is reused until the map changes");
KM.setBindings("fit",[{key:"F"}]);assert.notEqual(KM.table(),t1);KM.resetAll();
// ------------------------------------------------------------ keys lazy modules register (rooms, multichannel, bus routing)
// Commands registered after load still have no conflict or hidden key in any preset (KiCad N, RTS D).
{
  const before=KM.preset();
  for(const [id,key,when] of [["rooms:room-move","D M M","pcb"],["rooms:rooms-fit","D M F","pcb"],["multichannel:mc-sync","D M U",""],
    ["multichannel:room-replicate","D M C","pcb"],["bus:neck","N","routing"],["bus:via-pattern","B","routing"],["bus:reverse","Alt+/","routing"]])
    if(!KM.command(id))KM.registerCommand({id,title:id,category:"Test",when,defaultKeys:[{key,when}]});
  for(const p of KM.presets()){KM.setPreset(p.id);for(const mac of [false,true]){KM.setPlatform(mac);assert.deepEqual(KM.conflicts().map(c=>c.message),[],p.id+" with lazy module keys ("+(mac?"Mac":"PC")+")");}}
  const help = () => KM.cheatSheet("pcb").flatMap(group=>group.rows.map(row=>row.id));
  for(const p of KM.presets()){
    KM.setPreset(p.id);
    assert.notEqual(KM.resolve("/",pcb),"insert-palette",p.id+" preserves the ordinary slash while Labs is off");
    const rows=help();
    assert.ok(rows.includes("command-palette") && !rows.includes("insert-palette"),p.id+" documents the available commands");
  }
  require("../fixtures/notebook-labs.cjs").enable();
  KM.setPreset("altium");
  const power=net=>({dataset:{action:"sch-power",powerNet:net}});
  assert.equal(KM.menuHintKey(power("GND"),"schematic"),"","a net placement cannot advertise the generic Power Port picker");
  let placed=0;
  const port=KM.registerCommand({id:"power:GND",title:"Place Power Port: GND",defaultKeys:"Alt+F12",when:"schematic",notebook:true,run:()=>placed++});
  assert.equal(KM.menuHintKey(power("GND"),"schematic"),"Alt+F12");
  assert.equal(KM.menuHintKey(power("VCC"),"schematic"),"");
  assert.ok(KM.hintKey("sch-power","schematic"),"the picker keeps its own shortcut");
  assert.equal(placed,0,"querying a resolved menu binding cannot invoke it");
  port.dispose();
  for(const p of KM.presets()){
    KM.setPreset(p.id);
    // The default and the presets built on it search everything with / (insert-aware on notebook sheets); Classic keeps Insert.
    assert.ok(["insert-palette","search"].includes(KM.resolve("/",pcb)),p.id+" inserts at the pointer or searches");
    assert.equal(KM.resolve("F1",sch),"command-palette",p.id+" searches commands");
    assert.ok(help().includes("insert-palette")||help().includes("search"),p.id+" documents Insert or Search when Labs is enabled");
  }
  KM.setPlatform(false);KM.setPreset(before);
}
console.log("PASS key map: conflicts, sequence trie, presets, override precedence, import/export, storage failures, extension commands and platform text.");
function memory(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};}
