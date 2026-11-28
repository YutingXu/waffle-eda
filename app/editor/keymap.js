"use strict";

// Resolve keys through a trie of key indices and modifier masks, without allocating
// on keydown. Presets and user overrides replace defaults by command.
globalThis.AtriumKeymap = (() => {
  const CTRL=1,SHIFT=2,ALT=4,META=8,MODS=CTRL|ALT|META,MODIFIER=-2;
  const platform=globalThis.navigator?.platform||"";
  let mac=/Mac|iPhone|iPad/i.test(platform);
  const pcMeta=/^Win/i.test(platform)?"Win":/Linux/i.test(platform)?"Super":"Meta";
  const markPlatform=()=>globalThis.document?.documentElement?.toggleAttribute?.("data-mac-shortcuts",mac);
  markPlatform();

  // ---------------------------------------------------------------- keys
  const names=[],byName=new Map(),fromKey=new Map(),fromCode=new Map(),shifted=[];
  function key(name,keys=[name],codes=[],implied=false){
    const i=names.length;names.push(name);shifted.push(implied);byName.set(name.toLowerCase(),i);
    for(const k of keys)fromKey.set(k,i);for(const c of codes)fromCode.set(c,i);return i;
  }
  for(let c=65;c<91;c++){const L=String.fromCharCode(c);key(L,[L,L.toLowerCase()],["Key"+L]);}
  for(let d=0;d<10;d++)key(String(d),[String(d)],["Digit"+d,"Numpad"+d]);
  for(let f=1;f<=24;f++)key("F"+f,["F"+f],["F"+f]);
  const SPACE=key("Space",[" ","Spacebar"],["Space"]),ESCAPE=key("Escape",["Escape","Esc"],["Escape"]);
  key("Enter",["Enter"],["Enter","NumpadEnter"]);key("Tab",["Tab"],["Tab"]);key("Backspace",["Backspace"],["Backspace"]);
  key("Delete",["Delete","Del"],["Delete"]);key("Insert",["Insert"],["Insert"]);key("Home",["Home"],["Home"]);key("End",["End"],["End"]);
  key("PageUp",["PageUp"],["PageUp"]);key("PageDown",["PageDown"],["PageDown"]);
  for(const d of ["Up","Down","Left","Right"])key(d,["Arrow"+d,d],["Arrow"+d]);
  key("ContextMenu",["ContextMenu"],["ContextMenu"]);
  for(const [k,codes] of [["-",["Minus","NumpadSubtract"]],["=",["Equal"]],["\\",["Backslash","IntlBackslash"]],["/",["Slash","NumpadDivide"]],
    [",",["Comma"]],[".",["Period"]],[";",["Semicolon"]],["'",["Quote"]],["[",["BracketLeft"]],["]",["BracketRight"]],["`",["Backquote"]]])key(k,[k],codes);
  // Characters typed with Shift on common layouts: the character carries the Shift.
  key("+",["+"],["NumpadAdd"],true);key("*",["*"],["NumpadMultiply"],true);
  for(const k of "?!@#$%^&()_{}|:\"<>~")key(k,[k],[],true);
  for(const m of ["Shift","Control","Meta","Alt","AltGraph","CapsLock","OS","Fn","FnLock","Hyper","Super","NumLock","ScrollLock","Symbol","SymbolLock"])fromKey.set(m,MODIFIER);
  const aliases={esc:"escape",del:"delete",return:"enter",spacebar:"space",pgup:"pageup",pgdn:"pagedown",arrowup:"up",arrowdown:"down",
    arrowleft:"left",arrowright:"right","↑":"up","↓":"down","←":"left","→":"right",plus:"+",minus:"-",backslash:"\\",slash:"/",equal:"=",comma:",",period:".",question:"?"};
  const ENTER=byName.get("enter");
  // The key index of an event, or MODIFIER, or -1. Alt changes e.key on macOS (Alt+F
  // types "ƒ"), so Alt chords and unmapped layouts resolve by physical key.
  function eventKey(e){
    let i;
    // Ctrl/⌘ digits resolve by physical key too: Mod+Shift+1 types "!" on a US layout (selection memory).
    if(!e.altKey&&!((e.ctrlKey||e.metaKey)&&e.code&&e.code.length===6&&e.code.startsWith("Digit"))){i=fromKey.get(e.key);if(i!==undefined)return i;}
    i=fromCode.get(e.code);if(i!==undefined)return i;
    i=fromKey.get(e.key);return i===undefined?-1:i;
  }
  function eventMask(e,i){
    const m=(e.ctrlKey?CTRL:0)|(e.shiftKey?SHIFT:0)|(e.altKey?ALT:0)|(e.metaKey?META:0);
    return i>=0&&shifted[i]?m&~SHIFT:m;
  }

  // ---------------------------------------------------------------- key text
  const MOD_WORDS={mod:"mod",cmdorctrl:"mod",ctrl:CTRL,control:CTRL,"⌃":CTRL,shift:SHIFT,"⇧":SHIFT,alt:ALT,option:ALT,opt:ALT,"⌥":ALT,
    cmd:META,command:META,meta:META,super:META,win:META,"⌘":META};
  function parseChord(text){
    const parts=[];let rest=text;
    for(;;){const at=rest.indexOf("+",1);if(at<0){parts.push(rest);break;}parts.push(rest.slice(0,at));rest=rest.slice(at+1);}
    let mods=0,mod=false;
    for(const p of parts.slice(0,-1)){
      const w=MOD_WORDS[p.trim().toLowerCase()];
      if(w==="mod")mod=true;else if(w)mods|=w;else throw Error("Unknown modifier “"+p+"”.");
    }
    const last=parts.at(-1).trim(),lower=last.toLowerCase();
    let k=byName.get(aliases[lower]||lower);
    if(k===undefined&&last.length===1)k=fromKey.get(last);
    if(k===undefined||k<0)throw Error("Unknown key “"+last+"”.");
    if(shifted[k])mods&=~SHIFT;
    return {key:k,mods,mod};
  }
  // "Mod+K Mod+S", "P W", "P, W" and "Shift+F1" are all valid.
  function parse(text){
    const tokens=String(text??"").trim().split(/\s+/).filter(Boolean).map(t=>t.length>1&&t.endsWith(",")&&!t.endsWith("+,")?t.slice(0,-1):t);
    if(!tokens.length)throw Error("Empty key binding.");
    if(tokens.length>4)throw Error("A key sequence has at most four keys.");
    return tokens.map(parseChord);
  }
  function chordText(c){
    return [c.mod&&"Mod",c.mods&CTRL&&"Ctrl",c.mods&ALT&&"Alt",c.mods&SHIFT&&"Shift",c.mods&META&&"Meta",names[c.key]].filter(Boolean).join("+");
  }
  const normalize=text=>parse(text).map(chordText).join(" ");
  const ARROWS={Up:"↑",Down:"↓",Left:"←",Right:"→"};
  const MAC_KEYS={...ARROWS,Escape:"esc",Enter:"⏎",Tab:"⇥",Backspace:"⌫",Delete:"⌦",Home:"↖",End:"↘",PageUp:"⇞",PageDown:"⇟"};
  const PC_KEYS={...ARROWS,Escape:"Esc",PageUp:"PgUp",PageDown:"PgDn",Delete:"Del"};
  const MAC_WORDS={Enter:"Return",Backspace:"Delete",Delete:"Forward Delete"};
  const KEY_WORDS={Up:"Up Arrow",Down:"Down Arrow",Left:"Left Arrow",Right:"Right Arrow",PageUp:"Page Up",PageDown:"Page Down",ContextMenu:"Context Menu",
    "+":"Plus","-":"Minus","=":"Equal",",":"Comma",".":"Period","/":"Slash","\\":"Backslash","?":"Question Mark","*":"Asterisk",
    "'":"Apostrophe",'"':"Quotation Mark","`":"Backtick","[":"Left Bracket","]":"Right Bracket","{":"Left Brace","}":"Right Brace",
    "!":"Exclamation Mark","@":"At Sign","#":"Number Sign","$":"Dollar Sign","%":"Percent Sign","^":"Caret","&":"Ampersand",
    "(":"Left Parenthesis",")":"Right Parenthesis","_":"Underscore","|":"Vertical Bar",":":"Colon",";":"Semicolon","<":"Less Than",">":"Greater Than","~":"Tilde"};
  function chordKeys(c,spoken,spellComma=false){
    const key=spellComma&&names[c.key]===","?"Comma":names[c.key]||"", mods=c.mods|(c.mod?(mac?META:CTRL):0);
    if(mac&&!spoken){
      return [mods&CTRL&&"⌃",mods&ALT&&"⌥",mods&SHIFT&&"⇧",mods&META&&"⌘",MAC_KEYS[key]||key].filter(Boolean);
    }
    const k=spoken?(mac&&MAC_WORDS[key])||KEY_WORDS[key]||key:PC_KEYS[key]||key;
    const meta=mac?"Command":spoken&&pcMeta==="Win"?"Windows":pcMeta;
    return [mods&CTRL&&(spoken?"Control":"Ctrl"),mods&ALT&&(mac?"Option":"Alt"),mods&SHIFT&&"Shift",mods&META&&meta,k].filter(Boolean);
  }
  function displayKeys(text,spoken=false){
    if(text==null||text==="")return [];
    const mod=MOD_WORDS[String(text).trim().toLowerCase()];
    if(typeof mod==="number"||mod==="mod")return [chordKeys({mods:mod==="mod"?0:mod,mod:mod==="mod"},spoken)];
    try{
      const sequence=parse(text);
      return sequence.map(c=>chordKeys(c,spoken,sequence.length>1));
    }catch{return [[String(text)]];}
  }
  const joinKeys=(keys,spoken)=>keys.join(mac&&!spoken?"":"+");
  const displayParts=(text,spoken=false)=>displayKeys(text,spoken).map(keys=>joinKeys(keys,spoken));
  const display=(text,spoken=false)=>displayParts(text,spoken).join(spoken?", then ":", ");
  const label=(key,node)=>globalThis.AtriumShortcut.render(key,{node});
  // Recorder text for one keydown, or null for a lone modifier.
  function chordFromEvent(e){
    const i=eventKey(e);if(i<0)return null;
    let m=eventMask(e,i);const parts=[],primary=mac?META:CTRL;
    if(m&primary){parts.push("Mod");m&=~primary;}
    if(m&CTRL)parts.push("Ctrl");if(m&ALT)parts.push("Alt");if(m&SHIFT)parts.push("Shift");if(m&META)parts.push("Meta");
    parts.push(names[i]);return parts.join("+");
  }

  // ---------------------------------------------------------------- when
  // Grammar: || && ! ( ) and comparisons (== != >= <= > <). A bare word on the right of
  // == or != is a string: `tool == route`. Unknown names read the editor state by path.
  const VARS={
    pcb:s=>s.kind==="pcb",schematic:s=>s.kind==="schematic",kind:s=>s.kind,tool:s=>s.tool,
    routing:s=>s.tool==="route"||s.tool==="route-diffpair",placing:s=>!!s.interactive,interactive:s=>!!s.interactive,moving:s=>s.tool==="move-object",
    busRouting:s=>!!s.busRouting,
    selection:s=>!!s.selected||s.selectionCount>0,"selection.count":s=>s.selectionCount??(s.selected?1:0),
    tuning:s=>!!s.tuning&&typeof s.tool==="string"&&s.tool.startsWith("length-tune"),
    rotatable:s=>!!s.rotatable,canvas:(s,c)=>c,view3d:s=>!!s.view3d,canProperties:s=>!!s.canProperties,cursorAt:s=>!!s.cursorAt,dragging:s=>!!s.dragging,
    suggestion:s=>s.suggestion??!!globalThis.AtriumRouteSuggest?.visible?.(),suggestTab:s=>s.suggestTab??!!globalThis.AtriumRouteSuggest?.tabAccepts?.(),
    true:()=>true,false:()=>false
  };
  const whenCache=new Map();
  function compileWhen(src){
    src=String(src??"").trim();if(!src)return null;
    if(whenCache.has(src))return whenCache.get(src);
    const tokens=[],re=/\s*(\(|\)|&&|\|\||!=|==|>=|<=|>|<|!|[A-Za-z_][\w.-]*|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")/y;
    let at=0;
    while(at<src.length){re.lastIndex=at;const m=re.exec(src);if(!m){if(/^\s*$/.test(src.slice(at)))break;throw Error("Cannot read context “"+src+"” at “"+src.slice(at).trim()+"”.");}tokens.push(m[1]);at=re.lastIndex;}
    let n=0;const peek=()=>tokens[n],next=()=>tokens[n++];
    function value(tok,literal){
      if(tok===undefined)throw Error("Context “"+src+"” ends early.");
      if(/^-?\d/.test(tok)){const v=Number(tok);return ()=>v;}
      if(/^['"]/.test(tok)){const v=tok.slice(1,-1);return ()=>v;}
      if(literal)return ()=>tok;
      if(VARS[tok])return VARS[tok];
      const path=tok.split(".");
      return s=>{let v=s;for(let i=0;i<path.length&&v!=null;i++)v=v[path[i]];return v===undefined&&s.__assume?true:v;};
    }
    function atom(){
      const t=next();
      if(t==="("){const e=or();if(next()!==")")throw Error("Missing “)” in “"+src+"”.");return e;}
      if(t==="!"){const e=atom();return (s,c)=>!e(s,c);}
      if(t===")"||t==="&&"||t==="||")throw Error("Unexpected “"+t+"” in “"+src+"”.");
      const left=value(t),op=peek();
      if(!["==","!=",">=","<=",">","<"].includes(op))return left;
      next();const right=value(next(),op==="=="||op==="!=");
      switch(op){
        case "==":return (s,c)=>left(s,c)==right(s,c);case "!=":return (s,c)=>left(s,c)!=right(s,c);
        case ">=":return (s,c)=>left(s,c)>=right(s,c);case "<=":return (s,c)=>left(s,c)<=right(s,c);
        case ">":return (s,c)=>left(s,c)>right(s,c);default:return (s,c)=>left(s,c)<right(s,c);
      }
    }
    function and(){let e=atom();while(peek()==="&&"){next();const a=e,b=atom();e=(s,c)=>!!a(s,c)&&!!b(s,c);}return e;}
    function or(){let e=and();while(peek()==="||"){next();const a=e,b=and();e=(s,c)=>!!a(s,c)||!!b(s,c);}return e;}
    const fn=or();if(n<tokens.length)throw Error("Unexpected “"+tokens[n]+"” in “"+src+"”.");
    const test=(s,c)=>!!fn(s,c);whenCache.set(src,test);return test;
  }

  // ---------------------------------------------------------------- commands
  // [id, title, category, extra]. `action`/`param` default to the id; `titles` name the
  // command per editor; `short` labels it in the sequence hint. `palette` opens that entrance.
  const nudge=(d,v,n)=>({action:d,param:v.map(x=>x*n),repeatable:true});
  const BUILTIN=[
    ["new","New project…","File"],["open","Open…","File"],["import-altium","Import Altium project or document…","File"],["import-report","Import report","Reports"],["save","Save project","File",{inForms:true}],["close-project","Close project","File"],
    ["fab","Fabrication outputs…","File"],["output-jobs","Release…","File"],["print","Print…","File"],["export-pdf","Export PDF…","File"],["export","Export design…","File"],["export-altium","Export Altium project (ASCII, preview)…","File"],
    ["undo","Undo","Edit"],["redo","Redo","Edit"],["cut","Cut","Edit"],["copy","Copy","Edit"],["paste","Paste","Edit"],
    ["duplicate","Duplicate","Edit"],["select-all","Select all","Edit"],["deselect","Deselect all","Edit"],
    ["delete","Delete selection","Edit"],["rotate","Rotate selection","Edit"],
    ["mirror-x","Mirror horizontally (X)","Edit",{when:"schematic",short:"Mirror X"}],["mirror-y","Mirror vertically (Y)","Edit",{when:"schematic",short:"Mirror Y"}],
    ["find","Find in project…","Edit",{short:"Find",palette:"find"}],["search","Search everything…","View",{short:"Search",palette:""}],["find-text","Find text…","Edit",{when:"schematic"}],["find-replace","Find and replace text…","Edit"],["paste-special","Paste special…","Edit"],["paste-array","Paste array…","Edit"],
    ["rubber-stamp","Rubber stamp (paste until Escape)","Edit"],["clipboard-picker","Clipboard history (paste an earlier copy)…","Edit",{short:"Clipboard history"}],["sch-auto-increment","Toggle auto-increment on placement","Place",{when:"schematic"}],
    ["rotate-ccw","Rotate counterclockwise","Edit"],["rotate-cw","Rotate clockwise","Edit"],
    ["move-object","Move object","Edit"],
    ["align-left","Align left","Edit"],["align-right","Align right","Edit"],["align-top","Align top","Edit"],["align-bottom","Align bottom","Edit"],
    ["align-hcenter","Align horizontal centers","Edit"],["align-vcenter","Align vertical centers","Edit"],
    ["distribute-h","Distribute horizontally","Edit"],["distribute-v","Distribute vertically","Edit"],["align-grid","Align to grid","Edit"],
    ["make-row","Make row at pitch…","Edit"],["make-column","Make column at pitch…","Edit"],
    ["lasso-select","Lasso select","Edit",{short:"Lasso"}],["pin-swap","Interactive pin/gate swap","Tools",{when:"pcb",short:"Pin swap"}],
    ["gate-swap","Interactive gate (part) swap","Tools",{when:"pcb",short:"Gate swap"}],["swap-optimise","Automatic net/pin optimizer…","Tools",{when:"pcb",short:"Pin optimizer"}],
    ["flip-side","Flip component to other side","Edit",{when:"pcb",short:"Flip side"}],["find-similar","Find similar objects…","Edit",{when:"pcb || schematic"}],
    ["lock","Lock selection","Edit",{when:"pcb"}],["unlock","Unlock selection","Edit",{when:"pcb"}],
    ["union-create","Create union from selection","Edit",{when:"pcb"}],["union-add","Add selection to union","Edit",{when:"pcb"}],["union-break","Break union","Edit",{when:"pcb"}],
    ["flip-board","Flip board view","View",{when:"pcb",short:"Flip board"}],["hud","Toggle heads-up display","View",{when:"pcb"}],
    ["snap-object","Toggle object snap","View",{when:"pcb"}],["snap-options","Snap options…","View",{when:"pcb"}],
    ["symbol-wizard","Symbol wizard (from a pin table)…","Tools",{short:"Symbol wizard"}],["teardrops","Teardrops…","Tools",{when:"pcb",short:"Teardrops"}],["autoplace-proposal","Auto place (proposal)…","Tools",{when:"pcb",short:"Auto place"}],["plan-power-planes","Plan power planes…","Tools",{when:"pcb",short:"Power planes"}],["pdn-analysis","PDN analyzer (DC voltage drop, current density)…","Tools",{when:"pcb",short:"PDN analyzer"}],["calculators","Calculators (track width, via, impedance, E-series …)","Tools",{short:"Calculators"}],["pour-manager","Polygon pour manager (Pours panel)","Design",{when:"pcb",short:"Pours"}],
    ["smart-guides","Toggle smart guides","View"],
    ["designators-place","Auto-place designators","Tools",{when:"pcb"}],["designators-follow","Designators follow moved parts","Tools",{when:"pcb"}],["split-wire","Split wire","Edit",{when:"schematic"}],["escape","Cancel / end current stage","Edit"],
    ["swap-components","Swap selected components","Edit",{short:"Swap components"}],
    ["swap-components-origin","Swap selected components by origin","Edit",{short:"Swap by origin"}],
    ["swap-variant","Cycle footprint variant","Edit",{short:"Next footprint variant"}],
    ["swap-variant-back","Cycle footprint variant backwards","Edit",{short:"Previous footprint variant"}],
    ["swap-variant-pick","Choose footprint variant…","Edit",{short:"Footprint variant"}],
    ["swap-library","Replace with library part…","Edit",{short:"Library part"}],
    ["nudge-left","Nudge selection left","Edit",nudge("nudge",[-1,0],1)],["nudge-right","Nudge selection right","Edit",nudge("nudge",[1,0],1)],
    ["nudge-up","Nudge selection up","Edit",nudge("nudge",[0,-1],1)],["nudge-down","Nudge selection down","Edit",nudge("nudge",[0,1],1)],
    ["nudge-left-10","Nudge selection left ×10","Edit",nudge("nudge",[-1,0],10)],["nudge-right-10","Nudge selection right ×10","Edit",nudge("nudge",[1,0],10)],
    ["nudge-up-10","Nudge selection up ×10","Edit",nudge("nudge",[0,-1],10)],["nudge-down-10","Nudge selection down ×10","Edit",nudge("nudge",[0,1],10)],
    ["library","Place component","Place",{short:"Component"}],["quick-place","Quick place component…","Place",{palette:"library"}],["library-catalogue","Component catalogue…","Place",{short:"Catalogue"}],["route","Route","Place",{titles:{pcb:"Route track",schematic:"Wire"}}],
    ["start-wire","Start wire at cursor","Place",{when:"schematic"}],
    ["via","Place via","Place",{when:"pcb",short:"Via"}],["label","Place label","Place",{titles:{pcb:"String",schematic:"Net label"}}],
    ["junction","Place junction","Place",{when:"schematic",short:"Junction"}],["select","Select tool","Place"],
    ["sch-power","Place power port…","Place",{when:"schematic",short:"Power port"}],["sch-port","Place port…","Place",{when:"schematic",short:"Port"}],
    ["sch-offsheet","Place off sheet connector…","Place",{when:"schematic",short:"Off sheet connector"}],
    ["sch-sheet-symbol","Place sheet symbol…","Place",{when:"schematic",short:"Sheet symbol"}],["sch-sheet-entry","Place sheet entry","Place",{when:"schematic",short:"Sheet entry"}],
    ["sch-bus","Place bus","Place",{when:"schematic",short:"Bus"}],["sch-bus-entry","Place bus entry","Place",{when:"schematic",short:"Bus entry"}],
    ["sch-noerc","Place Generic No ERC","Place",{when:"schematic",short:"Generic No ERC"}],["sch-text","Place text string…","Place",{when:"schematic",short:"Text string"}],
    ["sch-frame","Place frame","Place",{when:"schematic",short:"Frame"}],
    ["sch-textframe","Place text frame","Place",{when:"schematic",short:"Text frame"}],["sch-note","Place note","Place",{when:"schematic",short:"Note"}],["sch-calculation","Place calculation","Place",{when:"schematic",short:"Calculation"}],
    ["sch-line","Draw line","Place",{when:"schematic",short:"Line"}],["sch-rect","Draw rectangle","Place",{when:"schematic",short:"Rectangle"}],
    ["sch-arc","Draw arc","Place",{when:"schematic",short:"Arc"}],["sch-polygon","Draw polygon","Place",{when:"schematic",short:"Polygon"}],
    ["sch-image","Place image…","Place",{when:"schematic",short:"Image"}],
    ["sch-hierarchy-up","Up hierarchy (parent sheet)","Tools",{when:"schematic",short:"Up hierarchy"}],
    ["sch-hierarchy-down","Down hierarchy (child sheet)","Tools",{when:"schematic",short:"Down hierarchy"}],
    ["sch-sync-entries","Synchronize sheet entries and ports","Design",{when:"schematic"}],
    ["sch-hop-overs","Toggle hop-over wire crossings","View",{when:"schematic"}],
    ["route-diffpair","Interactive differential pair routing","Place",{when:"pcb",short:"Differential pair"}],
    ["polygon-pour","Place polygon pour…","Place",{when:"pcb",short:"Polygon pour"}],
    ["pcb-pad","Place pad","Place",{when:"pcb",short:"Pad"}],["pcb-fill","Place fill","Place",{when:"pcb",short:"Fill"}],
    ["pcb-region","Place solid region","Place",{when:"pcb",short:"Solid region"}],["pcb-line","Place line","Place",{when:"pcb",short:"Line"}],
    ["pcb-arc-center","Place arc (center)","Place",{when:"pcb",short:"Arc (center)"}],["pcb-arc-edge","Place arc (edge)","Place",{when:"pcb",short:"Arc (edge)"}],
    ["pcb-arc-3pt","Place arc (3 points)","Place",{when:"pcb",short:"Arc (any angle)"}],
    ["pcb-keepout-track","Place keepout track","Place",{when:"pcb",short:"Track"}],["pcb-keepout-arc","Place keepout arc","Place",{when:"pcb",short:"Arc"}],
    ["pcb-keepout-fill","Place keepout fill","Place",{when:"pcb",short:"Fill"}],["pcb-keepout-region","Place keepout region","Place",{when:"pcb",short:"Solid region"}],
    ["pcb-dim-linear","Place linear dimension","Place",{when:"pcb",short:"Linear"}],["pcb-dim-aligned","Place aligned dimension","Place",{when:"pcb",short:"Aligned"}],
    ["pcb-dim-radial","Place radial dimension","Place",{when:"pcb",short:"Radial"}],["pcb-dim-angular","Place angular dimension","Place",{when:"pcb",short:"Angular"}],
    ["measure-primitives","Measure primitives (edge-to-edge clearance)","Reports",{when:"pcb",short:"Measure primitives"}],
    ["measure-selected","Measure selected objects","Reports",{when:"pcb"}],
    ["board-edit-vertices","Edit board shape vertices","Design",{when:"pcb",short:"Edit board shape"}],
    ["keep-routing","Keep routing","Routing"],
    ["route-conflict","Cycle routing conflict mode","Routing",{when:"pcb"}],
    ["route-layer-next","Next routing layer","Routing",{when:"pcb"}],["route-layer-prev","Previous routing layer","Routing",{when:"pcb"}],
    ["route-via","Add via while routing","Routing",{when:"pcb"}],
    ["route-width","Next track width","Routing",{when:"pcb",param:1}],["route-width-prev","Previous track width","Routing",{when:"pcb",action:"route-width",param:-1}],
    ["route-via-size","Next via size","Routing",{when:"pcb",param:1}],["route-via-size-prev","Previous via size","Routing",{when:"pcb",action:"route-via-size",param:-1}],
    ["route-arc-larger","Larger arc radius","Routing",{when:"pcb",action:"route-arc",param:1}],["route-arc-smaller","Smaller arc radius","Routing",{when:"pcb",action:"route-arc",param:-1}],["route-bend","Turn the next corner","Routing"],
    ["route-mode","Cycle 90°, 45° and free-angle modes","Routing"],["route-back","Retract last routing click","Routing",{repeatable:true}],
    ["tool-properties","Edit tool properties","Routing"],
    ["length-tune","Interactive length tuning","Routing",{when:"pcb",short:"Length tuning"}],
    ["length-tune-pair","Interactive diff pair length tuning","Routing",{when:"pcb",short:"Diff pair length tuning"}],
    ["length-tune-skew","Diff pair skew tuning","Routing",{when:"pcb",short:"Skew tuning"}],
    ["length","Length manager…","Routing",{when:"pcb"}],
    // Keys inside a live tuning session; each calls executeKey("length-key", key).
    ["length-amplitude-down","Length tuning: amplitude −","Routing",{action:"length-key",param:"1",repeatable:true}],
    ["length-amplitude-up","Length tuning: amplitude +","Routing",{action:"length-key",param:"2",repeatable:true}],
    ["length-gap-down","Length tuning: gap −","Routing",{action:"length-key",param:"3",repeatable:true}],
    ["length-gap-up","Length tuning: gap +","Routing",{action:"length-key",param:"4",repeatable:true}],
    ["length-miter-down","Length tuning: miter −","Routing",{action:"length-key",param:",",repeatable:true}],
    ["length-miter-up","Length tuning: miter +","Routing",{action:"length-key",param:".",repeatable:true}],
    ["length-properties","Length tuning: properties","Routing",{action:"length-key",param:"Tab"}],
    ["length-rounding-down","Length tuning: sawtooth rounding −","Routing",{action:"length-key",param:"[",repeatable:true}],
    ["length-rounding-up","Length tuning: sawtooth rounding +","Routing",{action:"length-key",param:"]",repeatable:true}],
    ["length-tune-phase","Interactive phase tuning","Routing",{when:"pcb",short:"Phase tuning"}],
    ["phase-tune-static","Static phase matching (pairs in matched-length groups)","Routing",{when:"pcb"}],
    ["route-autoshrink","Toggle diff pair auto-shrink","Routing",{when:"pcb"}],
    ["route-transition","Cycle width/gap transitions (mitered, rounded, step)","Routing",{when:"pcb"}],
    ["diffpair-retrace","Retrace differential pair…","Routing",{when:"pcb"}],
    ["diffpair-gloss","Smooth pair width and gap transitions","Routing",{when:"pcb"}],
    ["route-tabs","Add T tabs (tabbed routing)","Routing",{when:"pcb"}],
    ["route-tabs-trapezoid","Add trapezoid tabs (tabbed routing)","Routing",{when:"pcb"}],
    ["drag-reroute-toggle","Toggle re-route on component drag","Routing",{when:"pcb"}],
    ["place-at-pointer","Place at cursor","Cursor"],["select-at-pointer","Select at cursor","Cursor"],
    ["cursor-left","Step cursor left","Cursor",nudge("cursor-step",[-1,0],1)],["cursor-right","Step cursor right","Cursor",nudge("cursor-step",[1,0],1)],
    ["cursor-up","Step cursor up","Cursor",nudge("cursor-step",[0,-1],1)],["cursor-down","Step cursor down","Cursor",nudge("cursor-step",[0,1],1)],
    ["cursor-left-10","Step cursor left ×10","Cursor",nudge("cursor-step",[-1,0],10)],["cursor-right-10","Step cursor right ×10","Cursor",nudge("cursor-step",[1,0],10)],
    ["cursor-up-10","Step cursor up ×10","Cursor",nudge("cursor-step",[0,-1],10)],["cursor-down-10","Step cursor down ×10","Cursor",nudge("cursor-step",[0,1],10)],
    ["fit","Fit design","View"],["fit-objects","Fit objects","View",{titles:{pcb:"Fit board"}}],["fit-document","Fit Document","View",{nativeKey:"0"}],
    ["zoom-in","Zoom in","View"],["zoom-out","Zoom out","View"],
    ["zoom-in-pointer","Zoom in at cursor","View",{action:"zoom-at",param:1.25,repeatable:true}],
    ["zoom-out-pointer","Zoom out at cursor","View",{action:"zoom-at",param:1/1.25,repeatable:true}],
    ["zoom-in-pointer-fine","Zoom in at cursor (fine)","View",{action:"zoom-at",param:1.1,repeatable:true}],
    ["zoom-out-pointer-fine","Zoom out at cursor (fine)","View",{action:"zoom-at",param:1/1.1,repeatable:true}],
    ["pan","Pan tool","View"],["pan-hold","Pan while held","View"],["grid","Toggle visible grid","View"],
    ["grid-next","Next snap spacing","View"],["grid-prev","Previous snap spacing","View",{action:"grid-next",param:-1}],
    ["grid-picker","Choose snap spacing…","View"],["grid-custom","Set custom snap spacing…","View"],
    ["toggle-units","Toggle units (mil / mm)","View"],["measure","Measure distance","View"],
    ["layer-controls","Layer controls","View",{when:"pcb"}],["view-config","View configuration…","View",{when:"pcb"}],["view-planning","Board planning mode","View",{when:"pcb"}],["view-2d","2D layout mode","View",{when:"pcb"}],["view-3d","3D layout mode","View",{when:"pcb"}],
    ["view3d-top","3D: view from top","View",{when:"pcb"}],["view3d-bottom","3D: view from bottom","View",{when:"pcb"}],["view3d-flip","3D: flip board","View",{when:"pcb"}],
    ["layer-mode","Cycle single-layer view","View",{when:"pcb"}],["unrouted","Show unrouted connections","View"],
    ["insert-palette","Insert or Search…","Place",{notebook:true,palette:"insert"}],
    ["command-palette","Show all commands (command palette)","View",{inForms:true,short:"Command palette",palette:"command"}],
    ["goto-object","Jump to object…","View",{short:"Object",palette:"@"}],["goto-location","Jump to location…","View",{short:"Location",palette:":"}],
    ["net-colours","Net colour override","View",{when:"pcb"}],
    ["cross-probe","Cross probe to the other document","Tools"],["cross-select","Cross select mode","Tools"],["context-menu","Object context menu","Edit"],
    ["select-net","Select net","Edit"],["highlight-net","Highlight net","View"],["net-properties","Net properties","View"],["delete-net-copper","Delete net copper (un-route net)","Routing",{when:"pcb"}],
    // Altium muscle memory (altium-keys.js and editor.js): layer stepping, preset choosers, pick tools, Un-Route scopes.
    ["layer-next","Next layer","View",{when:"pcb",short:"Next layer"}],["layer-prev","Previous layer","View",{when:"pcb",short:"Previous layer"}],
    ["layer-signal-next","Next signal layer","View",{when:"pcb",short:"Next signal layer"}],
    ["route-width-pick","Choose track width…","Routing",{when:"pcb",short:"Track width"}],["route-via-pick","Choose via size…","Routing",{when:"pcb",short:"Via size"}],
    ["delete-pick","Delete objects by clicking","Edit",{short:"Delete"}],
    ["select-inside","Select inside area","Edit",{short:"Inside area"}],["select-outside","Select outside area","Edit",{short:"Outside area"}],
    ["move-selection","Move selection","Edit",{short:"Move selection"}],["drag-object","Drag object","Edit",{short:"Drag"}],
    ["unroute-all","Un-route all","Routing",{when:"pcb",short:"All"}],["unroute-connection","Un-route connection","Routing",{when:"pcb",short:"Connection"}],
    ["unroute-component","Un-route component","Routing",{when:"pcb",short:"Component"}],["unroute-room","Un-route room","Routing",{when:"pcb",short:"Room"}],
    // Altium chords part 2 (altium-tools.js), split-pane focus (split-tabs.js) and Design › Simulate (sim-menu.js).
    ["select-touching","Select touching line","Edit",{short:"Touching line"}],["select-connection","Select connection","Edit",{when:"pcb",short:"Connection"}],
    ["select-physical","Select physical connection","Edit",{when:"pcb",short:"Physical connection"}],["align-dialog","Align objects…","Edit",{short:"Align…"}],
    ["spacing-h-more","Increase horizontal spacing","Edit",{when:"pcb"}],["spacing-h-less","Decrease horizontal spacing","Edit",{when:"pcb"}],
    ["spacing-v-more","Increase vertical spacing","Edit",{when:"pcb"}],["spacing-v-less","Decrease vertical spacing","Edit",{when:"pcb"}],
    ["autoroute-room","Auto route room…","Routing",{when:"pcb",short:"Room"}],
    ["move-corner-mode","Corner mode while moving","Edit"],["move-properties","Properties of the moving object","Edit"],
    ["focus-pane-next","Focus next pane","Window"],["focus-pane-prev","Focus previous pane","Window"],["focus-pane-other","Focus other pane (cycle)","Window"],
    ["focus-part-next","Focus next part (side bars, panes, bottom panel)","Window",{inForms:true,short:"Next part"}],["focus-part-prev","Focus previous part","Window",{inForms:true,short:"Previous part"}],
    ["move-panel","Move panel…","Window"],["zen-mode","Zen mode (maximise the canvas)","Window",{short:"Zen mode"}],
    ["layout-save","Save current layout…","Window"],["layout-manage","Manage layouts…","Window"],["layout-default","Layout: Default","Window"],
    ["layout-schematic","Layout: Schematic Capture","Window"],["layout-pcb","Layout: PCB Routing","Window"],["layout-review","Layout: Review","Window"],
    ["layout-auto","Switch layout by document kind","Window"],
    ["simulate","Mixed sim (SPICE simulation panel)","Design",{when:"schematic",short:"Mixed sim"}],["simulate-op","Simulate: operating point","Design",{when:"schematic"}],
    ["simulate-dc","Simulate: DC sweep","Design",{when:"schematic"}],["simulate-ac","Simulate: AC analysis","Design",{when:"schematic"}],["simulate-tran","Simulate: transient analysis","Design",{when:"schematic"}],
    ["autoroute-all","Auto route all…","Routing",{when:"pcb",short:"All"}],["autoroute-net","Auto route net…","Routing",{when:"pcb",short:"Net"}],
    ["autoroute-connection","Auto route connection…","Routing",{when:"pcb",short:"Connection"}],["autoroute-component","Auto route component…","Routing",{when:"pcb",short:"Component"}],
    ["autoroute-area","Auto route area…","Routing",{when:"pcb",short:"Area"}],["fanout","Fanout…","Routing",{when:"pcb",short:"Fanout"}],
    ["whats-new","What's new","Help"],["component-classes","Component classes…","Design",{when:"pcb"}],
    ["drc-online","Online DRC","Tools",{when:"pcb"}],["drc-clear","Clear DRC markers","Tools",{when:"pcb"}],["drc-next","Next violation","Tools",{short:"Next violation"}],["drc-prev","Previous violation","Tools",{short:"Previous violation"}],["insights-panel","List design insights","Tools"],["insights-next","Next design insight","Tools",{short:"Next insight"}],["insights-prev","Previous design insight","Tools",{short:"Previous insight"}],["insights-markers","Show design insights","View"],
    ["nets-panel","Nets panel","Window"],["signals-panel","Signals panel","Window"],["navigator-panel","Navigator panel","Window"],["comments-panel","Comments panel","Window"],["clipboard-panel","Clipboard panel","Window"],["history-panel","History panel (undo steps, local history)","Window"],["comments-show","Show comment pins","View"],["query-panel","Filter panel (query)","Window"],["query-clear","Clear filter and net highlight","View"],["layer-sets","Layer sets…","View",{when:"pcb"}],["pcb-list","List panel (SCH List / PCB List)","Window"],
    ["split-toggle","Split editor / close split","Window"],["split-right","Split right","Window"],["split-down","Split down","Window"],
    ["split-close","Close split","Window"],["split-counterpart","Split with counterpart (board or schematic)","Window",{titles:{pcb:"Split with schematic",schematic:"Split with board"},short:"Split with counterpart"}],["split-follow","Follow selection in the other pane","Window",{short:"Follow"}],["toggle-left","Projects panel","Window"],["toggle-right","Properties panel","Window"],["components-panel","Components panel","Window"],["messages","Messages panel","Window"],
    ["rules","Design rules…","Design",{short:"Design rules"}],["stackup","Layer stack manager…","Design"],
    ["drc","Design rule check…","Tools"],["repour","Repour all polygons","Tools",{when:"pcb",short:"Repour all"}],["annotate","Annotate schematics…","Tools"],["keyboard-shortcuts","Keyboard shortcuts…","Tools"],
    ["compile","Validate project (compile)","Project"],["erc","Error reporting options…","Project"],["add-schematic","Add schematic sheet…","Project"],
    ["add-pcb","Add PCB layout…","Project"],["add-existing","Add existing document to project…","Project"],["rename-document","Rename document…","Project"],["eco","Update PCB document (ECO)…","Project",{short:"Update PCB"}],["eco-reverse","Update schematics from PCB…","Project",{short:"Update schematics"}],
    ["compare","Change table…","Project"],["revisions","Board revisions…","Project"],["revision-release","Release revision…","Project"],["revision-new","New revision from…","Project"],["revision-compare","Compare with revision…","Project"],["review-changes","Changes since last save","Project"],["compare-branches","Compare branches…","Project"],["changes-since-opened","What changed since I last opened","Project"],["project-history","Project history","Project"],["file-history","File history","Project"],["object-history","Show history of this object","Project"],["merge-conflicts","Resolve merge conflicts…","Project"],["merge-files","Merge three files…","Project"],["git-merge-driver","Set up Git merge driver…","Project"],["diff-compare","Compare…","Project"],["diff-compare-with","Compare with…","Project"],["comment-add","Add comment","Project"],["comment-add-area","Add area comment","Project"],["comment-mode","Annotate mode (comment on objects and areas)","Project",{short:"Annotate"}],["symbols","Symbol preferences…","Project"],["blocks","Layout blocks…","Project"],
    ["history","History","Project"],["history-object","History of selected object","Project",{action:"object-history"}],
    ["connectivity","Connectivity review…","Project"],["sheet-overview","Sheet Overview","Project"],["mcp","AI integration…","Project"],["bom","Bill of materials…","Reports"],
    // Camera (camera.js), selection memory (selection-memory.js) and the minimap (minimap.js); all lazy.
    ["camera-pan-left","Pan view left","View",{repeatable:true,short:"Pan left"}],["camera-pan-left-fast","Pan view left (fast)","View",{repeatable:true,short:"Pan left fast"}],["camera-pan-right","Pan view right","View",{repeatable:true,short:"Pan right"}],["camera-pan-right-fast","Pan view right (fast)","View",{repeatable:true,short:"Pan right fast"}],
    ["camera-pan-up","Pan view up","View",{repeatable:true,short:"Pan up"}],["camera-pan-up-fast","Pan view up (fast)","View",{repeatable:true,short:"Pan up fast"}],["camera-pan-down","Pan view down","View",{repeatable:true,short:"Pan down"}],["camera-pan-down-fast","Pan view down (fast)","View",{repeatable:true,short:"Pan down fast"}],
    ["view-back","Previous view","View"],["view-forward","Next view","View"],["jump-alert","Jump to last alert","View",{short:"Last alert"}],
    ["minimap","Minimap","View"],["selection-memory","Selection memory panel","Window"],
    ["camera-store-1","Save view 1","View",{short:"Mark view 1"}],["camera-recall-1","Go to saved view 1","View",{short:"Saved view 1"}],["selmem-store-1","Store selection in memory 1","Edit"],["selmem-add-1","Add selection to memory 1","Edit"],["selmem-recall-1","Recall selection memory 1 (twice: fly to it)","Edit"],
    ["camera-store-2","Save view 2","View",{short:"Mark view 2"}],["camera-recall-2","Go to saved view 2","View",{short:"Saved view 2"}],["selmem-store-2","Store selection in memory 2","Edit"],["selmem-add-2","Add selection to memory 2","Edit"],["selmem-recall-2","Recall selection memory 2 (twice: fly to it)","Edit"],
    ["camera-store-3","Save view 3","View",{short:"Mark view 3"}],["camera-recall-3","Go to saved view 3","View",{short:"Saved view 3"}],["selmem-store-3","Store selection in memory 3","Edit"],["selmem-add-3","Add selection to memory 3","Edit"],["selmem-recall-3","Recall selection memory 3 (twice: fly to it)","Edit"],
    ["camera-store-4","Save view 4","View",{short:"Mark view 4"}],["camera-recall-4","Go to saved view 4","View",{short:"Saved view 4"}],["selmem-store-4","Store selection in memory 4","Edit"],["selmem-add-4","Add selection to memory 4","Edit"],["selmem-recall-4","Recall selection memory 4 (twice: fly to it)","Edit"],
    ["camera-store-5","Save view 5","View",{short:"Mark view 5"}],["camera-recall-5","Go to saved view 5","View",{short:"Saved view 5"}],["selmem-store-5","Store selection in memory 5","Edit"],["selmem-add-5","Add selection to memory 5","Edit"],["selmem-recall-5","Recall selection memory 5 (twice: fly to it)","Edit"],
    ["camera-store-6","Save view 6","View",{short:"Mark view 6"}],["camera-recall-6","Go to saved view 6","View",{short:"Saved view 6"}],["selmem-store-6","Store selection in memory 6","Edit"],["selmem-add-6","Add selection to memory 6","Edit"],["selmem-recall-6","Recall selection memory 6 (twice: fly to it)","Edit"],
    ["camera-store-7","Save view 7","View",{short:"Mark view 7"}],["camera-recall-7","Go to saved view 7","View",{short:"Saved view 7"}],["selmem-store-7","Store selection in memory 7","Edit"],["selmem-add-7","Add selection to memory 7","Edit"],["selmem-recall-7","Recall selection memory 7 (twice: fly to it)","Edit"],
    ["camera-store-8","Save view 8","View",{short:"Mark view 8"}],["camera-recall-8","Go to saved view 8","View",{short:"Saved view 8"}],["selmem-store-8","Store selection in memory 8","Edit"],["selmem-add-8","Add selection to memory 8","Edit"],["selmem-recall-8","Recall selection memory 8 (twice: fly to it)","Edit"],
    ["camera-store-9","Save view 9","View",{short:"Mark view 9"}],["camera-recall-9","Go to saved view 9","View",{short:"Saved view 9"}],["selmem-store-9","Store selection in memory 9","Edit"],["selmem-add-9","Add selection to memory 9","Edit"],["selmem-recall-9","Recall selection memory 9 (twice: fly to it)","Edit"],
    // VS Code-style workbench commands (vscode-keys.js, theme-picker.js, theme-editor.js; lazy).
    ["quick-open","Quick open (documents and recent files)…","View",{short:"Quick open",palette:"files"}],["theme-picker","Color theme…","View",{short:"Color theme"}],
    ["theme-editor","Customize theme…","View",{short:"Customize theme"}],["doc-next","Next document (quick switcher)","Window"],["doc-prev","Previous document (quick switcher)","Window"],
    ["close-document","Close document tab","Window",{inForms:true}],["reopen-document","Reopen closed document tab","Window"],["focus-projects","Focus the Projects panel","Window"],
    ["focus-extensions","Show extensions","Window",{action:"extensions"}],["toggle-console","Toggle the scripting console","Window",{action:"scripting-console"}],
    ["rename-object","Rename designator or net","Edit",{short:"Rename"}],["cheatsheet","Keyboard cheat sheet (overlay)","Help",{short:"Cheat sheet"}],
    ["shortcuts","Keyboard shortcut cheat sheet","Help"],["about","About Waffle","Help"],["licenses","Licences","Help"],["tutorial","Your first board tutorial","Help",{short:"Tutorial"}]
  ];
  const CATEGORIES=["File","Edit","Place","Routing","Cursor","View","Window","Design","Tools","Project","Reports","Help","Extensions"];
  const commands=new Map();
  let commandOrder=0;
  function addCommand(spec,builtin){
    const cmd={id:spec.id,title:String(spec.title||spec.id),category:spec.category||"Extensions",when:spec.when||"",
      action:spec.action??spec.id,param:spec.param,repeatable:!!spec.repeatable,inForms:!!spec.inForms,short:spec.short,
      titles:spec.titles||null,nativeKey:spec.nativeKey||"",run:typeof spec.run==="function"?spec.run:null,priority:!!spec.priority,notebook:!!spec.notebook,palette:builtin?spec.palette:undefined,builtin,order:commandOrder++};
    cmd.whenTest=compileWhen(cmd.when);
    commands.set(cmd.id,cmd);return cmd;
  }
  for(const [id,title,category,extra] of BUILTIN)addCommand({id,title,category,...extra},true);
  const fitDocument=commands.get("fit-document");
  const documentFitBinding=["Mod+"+fitDocument.nativeKey,fitDocument.id];

  // Default bindings in hint order: [keys, command, when, hint label].
  // On Mac, keep Ctrl+W/M/H distinct from the system's Command+W/M/H.
  const DEFAULTS=[
    ["P W","route","schematic","Wire"],["P P","library","schematic","Component"],["P N","label","schematic","Net label"],["P J","junction","schematic","Junction"],
    ["P T","route","pcb","Route track"],["P V","via","pcb","Via"],["P C","library","pcb","Component"],["P S","label","pcb","String"],
    ["P I","route-diffpair","pcb","Differential pair"],["P G","polygon-pour","pcb","Polygon pour"],
    ["P P","pcb-pad","pcb","Pad"],["P F","pcb-fill","pcb","Fill"],["P R","pcb-region","pcb","Solid region"],["P L","pcb-line","pcb","Line"],
    ["P A","pcb-arc-center","pcb","Arc (center)"],["P E","pcb-arc-edge","pcb","Arc (edge)"],["P N","pcb-arc-3pt","pcb","Arc (any angle)"],
    ["P K T","pcb-keepout-track","pcb","Track"],["P K A","pcb-keepout-arc","pcb","Arc"],["P K F","pcb-keepout-fill","pcb","Fill"],["P K R","pcb-keepout-region","pcb","Solid region"],
    ["P D L","pcb-dim-linear","pcb","Linear"],["P D G","pcb-dim-aligned","pcb","Aligned"],["P D R","pcb-dim-radial","pcb","Radial"],["P D A","pcb-dim-angular","pcb","Angular"],
    ["Mod+Shift+M","measure-primitives","pcb","Measure primitives"],["D S E","board-edit-vertices","pcb","Edit board shape"],
    ["P O","sch-power","schematic","Power port"],["P R","sch-port","schematic","Port"],["P C","sch-offsheet","schematic","Off sheet connector"],
    ["P S","sch-sheet-symbol","schematic","Sheet symbol"],["P A","sch-sheet-entry","schematic","Sheet entry"],["P B","sch-bus","schematic","Bus"],
    ["P U","sch-bus-entry","schematic","Bus entry"],["P V N","sch-noerc","schematic","Generic No ERC"],["P T","sch-text","schematic","Text string"],
    ["P F","sch-textframe","schematic","Text frame"],["P D N","sch-note","schematic","Note"],["P D L","sch-line","schematic","Line"],
    ["P D R","sch-rect","schematic","Rectangle"],["P D A","sch-arc","schematic","Arc"],["P D Y","sch-polygon","schematic","Polygon"],
    ["P D G","sch-image","schematic","Image"],["T H","sch-hierarchy-up","schematic","Up hierarchy"],
    ["V F","fit-objects","","Fit objects"],["V D","fit-document","","Fit document"],["V B","flip-board","pcb","Flip board"],["M M","move-object","","Move object"],
    ["X A","deselect","!schematic || !placing && !dragging","Deselect all"],
    ["X","mirror-x","schematic && (placing || dragging)"],["Y","mirror-y","schematic && (placing || dragging)"],["Mod+F","find"],["Mod+R","rubber-stamp"],["Mod+Alt+V","clipboard-picker"],["Mod+Alt+C","diff-compare"],["D R","rules",null,"Design rules"],
    ["T R","length-tune","","Length tuning"],["T I","length-tune-pair","","Diff pair tuning"],
    ["T G A","repour","pcb","Repour all"],["T W S","swap-components"],["T W F","swap-variant-pick"],["T W L","swap-library"],["T E","teardrops","pcb","Teardrops"],
    // Altium defaults (scripts/reachability.py lists the ones still missing): Tools » Design Rule Check,
    // Cross Probe, Annotate, Polygon Manager; Design » Layer Stack Manager, Update PCB, Classes.
    ["T D","drc","","Design rule check"],["T C","cross-probe","","Cross probe"],["T A A","annotate","schematic","Annotate schematics"],["T G M","pour-manager","pcb","Polygon manager"],
    ["D K","stackup","pcb","Layer stack manager"],["D U","eco","","Update PCB document"],["D C","component-classes","pcb","Classes"],
    ["Ctrl+M","measure"],["Ctrl+W","start-wire","schematic"],["Ctrl+W","route","pcb && !routing"],["Ctrl+W","keep-routing","pcb && routing"],
    ["Mod+L","view-config","pcb"],
    ["Mod+PageDown","fit-document","pcb"],["Mod+PageDown","fit-objects","schematic"],["Mod+\\","split-toggle"],["Mod+Alt+\\","split-counterpart"],
    ["Mod+Shift+G","grid","schematic"],["Mod+G","grid-custom"],
    ["Mod+Shift+L","align-left","selection"],["Mod+Shift+R","align-right","selection"],["Mod+Shift+T","align-top","selection"],
    ["Mod+Shift+B","align-bottom","selection"],["Mod+Shift+H","distribute-h","selection"],["Mod+Shift+V","distribute-v","selection"],
    ["Mod+Shift+D","align-grid","selection"],
    ...["left","right","up","down"].flatMap(d=>{const K=d[0].toUpperCase()+d.slice(1);
      return [["Mod+"+K,"nudge-"+d,"canvas && selection"],["Mod+Shift+"+K,"nudge-"+d+"-10","canvas && selection"]];}),
    ["Mod+S","save"],["Mod+O","open"],["Mod+P","quick-open"],["Mod+Z","undo"],["Mod+Shift+Z","redo"],["Mod+Y","redo"],["Mod+Alt+Z","history"],["Mod+C","copy"],["Mod+V","paste"],
    ["Mod+A","select-all"],["S L","lasso-select","!placing"],["T W P","pin-swap","pcb"],["T W G","gate-swap","pcb"],["T W O","swap-optimise","pcb"],["Mod+X","cut"],
    ["Mod+Alt+S","swap-components"],["Alt+F","swap-variant"],["Alt+Shift+F","swap-variant-pick"],
    ["Shift+F1","shortcuts"],["?","shortcuts"],
    ["Mod+Shift+P","command-palette"],["F1","command-palette"],["/","search"],["J C","goto-object","","Component / net"],["J L","goto-location","","Location"],
    ["N","unrouted","pcb && !placing"],["F5","net-colours","pcb"],["F8","drc-next"],["Shift+F8","drc-prev"],["Alt+F8","insights-next"],["Shift+Alt+F8","insights-prev"],["Shift+F10","context-menu","canvas"],["ContextMenu","context-menu","canvas"],
    ["Escape","escape","",null,true],
    ["Space","route-bend","routing"],["Shift+Space","route-mode","routing"],
    ["Space","rotate-ccw","rotatable && !routing"],["Shift+Space","rotate-cw","rotatable && !routing"],
    ["Space","pan-hold","!routing && !rotatable"],
    ["Enter","place-at-pointer","canvas && placing",null,true],["Enter","select-at-pointer","canvas && !placing && cursorAt && tool == select",null,true],
    ["Tab","tool-properties","canvas && canProperties"],
    ["1","length-amplitude-down","tuning"],["2","length-amplitude-up","tuning"],["3","length-gap-down","tuning"],["4","length-gap-up","tuning"],
    [",","length-miter-down","tuning"],[".","length-miter-up","tuning"],["Tab","length-properties","tuning"],
    ["[","length-rounding-down","tuning"],["]","length-rounding-up","tuning"],
    // Interactive routing (Altium): Shift+R conflict mode, 2 via, 3 width, 4 via size, , . arc radius.
    ["Shift+R","route-conflict","routing"],["2","route-via","routing"],["3","route-width","routing"],
    ["4","route-via-size","routing"],[".","route-arc-larger","routing"],[",","route-arc-smaller","routing"],
    ...["left","right","up","down"].flatMap(d=>{const K=d[0].toUpperCase()+d.slice(1);
      return [[K,"cursor-"+d,"canvas && (selection || placing)"],["Shift+"+K,"cursor-"+d+"-10","canvas && (selection || placing)"],
        [K,"camera-pan-"+d,"canvas && !selection && !placing"],["Shift+"+K,"camera-pan-"+d+"-fast","canvas && !selection && !placing"]];}),
    ["Backspace","route-back","routing",null,true],["Delete","route-back","routing",null,true],
    ["Backspace","delete","!placing && selection",null,true],["Delete","delete","!placing && selection",null,true],
    ["PageUp","zoom-in-pointer"],["PageDown","zoom-out-pointer"],
    ["Shift+PageUp","zoom-in-pointer","!pcb"],["Shift+PageDown","zoom-out-pointer","!pcb"],
    ["Shift+PageUp","zoom-in-pointer-fine","pcb"],["Shift+PageDown","zoom-out-pointer-fine","pcb"],
    ["L","flip-side","pcb && (moving || tool == place || dragging)"],["L","view-config","pcb && !placing && !dragging"],["Shift+F","find-similar","(pcb || schematic) && selection && !placing"],["Shift+H","hud","pcb"],["Shift+E","snap-object","pcb"],["1","view-planning","pcb && !routing && !tuning && !placing"],["2","view-2d","pcb && !routing && !tuning && !placing"],["3","view-3d","pcb && !routing && !tuning && !placing"],["F12","query-panel"],["Shift+C","query-clear"],["Shift+S","layer-mode","pcb"],["Shift+G","grid-prev","!pcb"],
    ["W","route","!routing"],["H","pan"],["L","label","!pcb && !placing"],
    ["F","fit","!view3d"],["0","view3d-top","view3d"],["9","view3d-bottom","view3d"],["F","view3d-flip","view3d"],["G","grid-picker","pcb"],["G","grid-next","!pcb"],["Q","toggle-units"],
    // ---- Altium chord pass (the Waffle Classic preset, keymap-presets.js, keeps the table from before it)
    // Reports: R M measure distance, R P measure primitives, R S measure selected objects, R B bill of materials.
    ["R M","measure","","Measure distance"],["R P","measure-primitives","pcb","Measure primitives"],["R S","measure-selected","pcb","Measure selected objects"],["R B","bom","","Bill of materials"],
    // Layers (numpad + − *; plain + and − too). Schematics keep + / − for zoom.
    ["+","layer-next","pcb"],["-","layer-prev","pcb"],["*","layer-signal-next","pcb"],["+","zoom-in","!pcb"],["-","zoom-out","!pcb"],
    ["Shift+W","route-width-pick","routing"],["Shift+V","route-via-pick","routing"],
    ["Ctrl+H","select-net","pcb"],["Ctrl+H","find-replace","schematic"],["Mod+Shift+F","find-replace"],["Mod+D","duplicate"],
    // Edit: E D delete by clicking, E S select…, E M move….
    ["E D","delete-pick","!placing","Delete"],
    ["E S I","select-inside","!placing","Inside area"],["E S O","select-outside","!placing","Outside area"],["E S N","select-net","!placing","Net"],
    ["E S L","lasso-select","!placing","Lasso"],["E S A","select-all","!placing","All"],
    ["E M M","move-object","!placing","Move"],["E M S","move-selection","!placing","Move selection"],["E M D","drag-object","!placing","Drag"],
    // Select and Move.
    ["S I","select-inside","!placing","Inside area"],["S O","select-outside","!placing","Outside area"],["S N","select-net","!placing","Net"],["S A","select-all","!placing","All"],
    ["M S","move-selection","","Move selection"],["M D","drag-object","","Drag"],
    // Align (Edit » Align). On boards A A and A F also run Auto Route All and Fanout.
    ["A L","align-left","","Left"],["A R","align-right","","Right"],["A C","align-hcenter","","Horizontal centers"],["A D","distribute-h","","Distribute horizontally"],
    ["A T","align-top","","Top"],["A B","align-bottom","","Bottom"],["A V","align-vcenter","","Vertical centers"],["A I","distribute-v","","Distribute vertically"],
    ["A G","align-grid","","Align to grid"],["A A","autoroute-all","pcb","Auto route all"],["A F","fanout","pcb","Fanout"],
    // Project: C C compile.
    ["C C","compile","","Compile"],["C M","comment-mode","","Annotate (comment mode)"],
    // Route: U T, U I, U R, U A (Auto Route…), U U (Un-Route…).
    ["U T","route","pcb","Interactive routing"],["U I","route-diffpair","pcb","Differential pair"],["U R","length-tune","pcb","Length tuning"],
    ["U A A","autoroute-all","pcb","All"],["U A N","autoroute-net","pcb","Net"],["U A C","autoroute-connection","pcb","Connection"],
    ["U A O","autoroute-component","pcb","Component"],["U A R","autoroute-area","pcb","Area"],["U A F","fanout","pcb","Fanout"],
    ["U U A","unroute-all","pcb","All"],["U U N","delete-net-copper","pcb","Net"],["U U C","unroute-connection","pcb","Connection"],
    ["U U O","unroute-component","pcb","Component"],["U U R","unroute-room","pcb","Room"],
    // Altium chords part 2: S T / S C / S P, Edit » Align (E G …; A A on sheets), U A M; Shift+Space and Tab while moving;
    // pane focus as in VS Code (Mod+K ←/→; F6 / Shift+F6 cycle parts), Mod+K Z Zen mode.
    ["S T","select-touching","!placing","Touching line"],["S C","select-connection","pcb && !placing","Connection"],["S P","select-physical","pcb && !placing","Physical connection"],
    ["E S T","select-touching","!placing","Touching line"],["E S C","select-connection","pcb && !placing","Connection"],["E S P","select-physical","pcb && !placing","Physical connection"],
    ["E G A","align-dialog","","Align…"],["E G L","align-left","","Left"],["E G R","align-right","","Right"],["E G C","align-hcenter","","Horizontal centers"],
    ["E G D","distribute-h","","Distribute horizontally"],["E G T","align-top","","Top"],["E G B","align-bottom","","Bottom"],["E G V","align-vcenter","","Vertical centers"],
    ["E G I","distribute-v","","Distribute vertically"],["E G G","align-grid","","Align to grid"],["A A","align-dialog","schematic","Align…"],
    ["U A M","autoroute-room","pcb","Room"],
    ["Shift+Space","move-corner-mode","(dragging || sticky) && !routing && !rotatable"],["Tab","move-properties","canvas && (dragging || sticky) && !canProperties && !tuning"],
    ["Mod+K Right","focus-pane-next"],["Mod+K Left","focus-pane-prev"],["F6","focus-part-next"],["Shift+F6","focus-part-prev"],["Mod+K Z","zen-mode"],
    // Camera (docs/shortcuts.md): Alt+←/→ (and the mouse thumb buttons) step the view history; J E jumps to the
    // last alert; J 1…9 go to a saved view (Altium's Jump menu), J M 1…9 mark (save) one. Selection memory is
    // Mod+1…9 store, Mod+Shift+1…9 add, Alt+1…9 recall (twice flies there); plain 1…3 stay Altium's view modes.
    ["Alt+Left","view-back","!view3d"],["Alt+Right","view-forward","!view3d"],["J E","jump-alert","","Last alert"],
    ...[1,2,3,4,5,6,7,8,9].flatMap(n=>[["J "+n,"camera-recall-"+n,"","Saved view "+n],["J M "+n,"camera-store-"+n,"","Mark view "+n],
      ["Mod+"+n,"selmem-store-"+n],["Mod+Shift+"+n,"selmem-add-"+n],["Alt+"+n,"selmem-recall-"+n]]),
    // VS Code layer (docs/shortcuts.md "VS Code keys"): only keys Altium leaves free. Mod+P (print), Mod+G (grid),
    // Ctrl+W (route) and Mod+Shift+T (align top) keep their Altium meaning here; the VS Code-like preset takes them.
    ["Mod+B","toggle-left"],["Mod+Alt+B","toggle-right"],["Mod+J","messages"],["Mod+K Mod+S","keyboard-shortcuts"],["Mod+K Mod+T","theme-picker"],
    ["Mod+Shift+O","goto-object"],["Mod+Shift+E","focus-projects"],["Mod+Shift+X","focus-extensions"],["Ctrl+`","toggle-console"],
    ["Ctrl+Tab","doc-next"],["Ctrl+Shift+Tab","doc-prev"],["Mod+Alt+Right","doc-next"],["Mod+Alt+Left","doc-prev"],["Mod+F4","close-document"],
    ["F2","rename-object","!placing"],["Mod+=","zoom-in"],["Mod+-","zoom-out"],documentFitBinding,["Mod+N","new"],["Mod+K W","split-close"],
    ["Mod+?","cheatsheet"],["Mod+Shift+/","cheatsheet"]
  ];
  // Shared Classic and Altium groups. Classic projects these slices; Ctrl+M stays on each preset.
  // placement 0:25, schematic/view 27:49, tune/pour/swap 56:63, tools/design 63:70, fit/split 75:79,
  // swap/help 111:116, escape/tool/tune 129:147, live route 150:153, delete/zoom 169:179.
  const sharedPlace=DEFAULTS.slice(0,25),sharedSchView=DEFAULTS.slice(27,49),sharedTune=DEFAULTS.slice(56,63),sharedTools=DEFAULTS.slice(63,70),sharedFit=DEFAULTS.slice(75,79),sharedSwapHelp=DEFAULTS.slice(111,116),sharedEscape=DEFAULTS.slice(129,147),sharedLiveRoute=DEFAULTS.slice(150,153),sharedDeleteZoom=DEFAULTS.slice(169,179);
  function table0(list){
    const m=new Map();
    list.forEach(([keys,id,when,label,anyShift,extra],order)=>{
      if(!m.has(id))m.set(id,[]);
      m.get(id).push({key:keys,when:when||"",label:label||undefined,anyShift:!!anyShift,order,lead:!!extra?.lead});
    });
    return m;
  }
  const defaults=table0(DEFAULTS);
  // Sequence-prefix names for the status bar hint.
  const PREFIX_NAMES={"J":"Jump","P D":"Drawing tools","P V":"Directives","P":"Place","V":"View","M":"Move","X":"Deselect","D":"Design","T":"Tools","T W":"Swap","T A":"Annotation","S":"Select","T G":"Polygon pours","P K":"Keepout","D S":"Board shape",
    "R":"Reports","E":"Edit","E S":"Select","E M":"Move","A":"Align","C":"Project","U":"Route","U A":"Auto Route","U U":"Un-Route","E G":"Align"};

  const b=(key,when="",extra)=>({key,when,...extra});
  // Waffle Classic, KiCad-like and VS Code-like live in keymap-presets.js (lazy): definePreset() adds them.
  const LAZY_PRESETS={classic:"Waffle Classic",kicad:"KiCad-like",vscode:"VS Code-like",allegro:"Allegro-like",modern:"Modern (Mac)"},ORDER=["altium","classic","kicad","vscode","allegro","modern"];
  const PRESETS={
    altium:{title:"Altium-style (default)",bindings:{}}
    // VS Code-like is lazy (keymap-presets.js): it takes VS Code meanings everywhere, built on this default.
  };
  // The RTS preset reserves WASD for the camera and rebinds conflicts.
  {
    const o={};
    for(const [id,list] of defaults){const keep=list.filter(x=>!/^[WASD]( |$)/.test(x.key));if(keep.length!==list.length)o[id]=keep;}
    for(const [d,k] of [["up","W"],["left","A"],["down","S"],["right","D"]]){
      const K=d[0].toUpperCase()+d.slice(1);
      o["camera-pan-"+d]=[b(K,"canvas && !selection && !placing"),b(k,"canvas && !placing")];
    }
    PRESETS.rts={title:"Altium + RTS camera (WASD, edge scroll)",bindings:o,rts:true};
  }

  // ---------------------------------------------------------------- state
  const STORE="atrium-keymap-v1";
  let storage=null;try{storage=globalThis.localStorage||null;}catch{}
  let presetName="altium",user=new Map(),compiled=null,bindingRevision=0;
  const listeners=new Set();
  function load(){
    try{const raw=storage?.getItem(STORE);if(raw)applyData(JSON.parse(raw),false);}catch{}
  }
  function save(){try{storage?.setItem(STORE,JSON.stringify(data()));}catch{}}
  function changed(persist=true){compiled=null;if(persist){bindingRevision++;save();}for(const fn of [...listeners]){try{fn();}catch(e){globalThis.console?.error?.(e);}}}
  function data(){
    const bindings={};
    for(const [id,list] of user)bindings[id]=list.map(x=>x.when?{key:x.key,when:x.when}:{key:x.key});
    return {format:"atrium-keys",version:1,preset:presetName,bindings};
  }
  // Validates imported data; bad keys or contexts are dropped and reported.
  function applyData(d,notify=true){
    if(!d||typeof d!=="object"||Array.isArray(d))throw Error("This is not a Waffle key map.");
    if(d.format!=null&&d.format!=="atrium-keys")throw Error("This is not a Waffle key map.");
    const problems=[],next=new Map();
    const raw=d.bindings&&typeof d.bindings==="object"&&!Array.isArray(d.bindings)?d.bindings:{};
    for(const id of Object.keys(raw)){
      const rows=raw[id];
      if(!Array.isArray(rows))continue;
      const list=[];
      for(const x of rows){
        const k=typeof x==="string"?x:x?.key,w=typeof x==="object"&&x?String(x.when||""):"";
        try{if(w)compileWhen(w);list.push({key:normalize(k),when:w});}catch(e){problems.push(id+": "+e.message);}
      }
      // Only an explicit empty list clears the command's binding.
      if(list.length||!rows.length)next.set(id,list);
    }
    // Both retired extension commands used to appear in Keyboard Shortcuts.
    for(const alias of ["calculators.show","calculators.compute"])if(next.has(alias)){
      const bindings=next.get("calculators")||[];
      for(const b of next.get(alias))if(!bindings.some(x=>x.key===b.key&&x.when===b.when))bindings.push(b);
      next.set("calculators",bindings);next.delete(alias);
    }
    presetName=Object.hasOwn(PRESETS,d.preset)||Object.hasOwn(LAZY_PRESETS,d.preset)?d.preset:"altium";user=next;
    if(!PRESETS[presetName])loadPresets();
    if(notify)changed();
    return problems;
  }

  function effective(id){
    if(user.has(id))return {source:"user",list:user.get(id)};
    const P=PRESETS[presetName],p=P?.bindings||{};
    if(Object.hasOwn(p,id))return {source:"preset",list:p[id]};
    // A preset with its own default table (Waffle Classic) leaves built-in commands it lacks unbound.
    const m=P?.defaults;
    const list=(m&&(m.has(id)||commands.get(id)?.builtin)?m:defaults).get(id)||[];
    // RTS camera: W A S D sequences of commands registered later (rooms, multichannel) give way too.
    return {source:"default",list:P?.rts?list.filter(x=>!/^[WASD]( |$)/.test(x.key)):list};
  }
  // keymap-presets.js (lazy) defines Waffle Classic and KiCad-like; until it loads they act as the default.
  function definePreset(id,spec){
    PRESETS[id]={title:spec.title||LAZY_PRESETS[id]||id,bindings:spec.bindings||{},defaults:spec.table?table0(spec.table):spec.base?PRESETS[spec.base]?.defaults:null};
    if(id===presetName){bindingRevision++;changed(false);}
  }
  let presetsLoading=null;
  const say=e=>globalThis.AtriumNavHost?.info?.(e.message);
  function loadPresets(){
    const L=globalThis.AtriumLazy;
    if(!L?.need){if(globalThis.document&&!presetsLoading)globalThis.setTimeout?.(()=>{if(!PRESETS[presetName])loadPresets();},0);return null;}
    if(presetsLoading)return presetsLoading;
    return presetsLoading=L.need("AtriumKeymapPresets").then(()=>{
      if(!PRESETS[presetName])throw Error("Couldn't load the selected keyboard preset.");
      changed(false);return true;
    }).catch(e=>{presetsLoading=null;say(e);return false;});
  }
  const pendingPreset=()=>PRESETS[presetName]?null:loadPresets();
  const presetTitle=id=>PRESETS[id]?.title||LAZY_PRESETS[id]||id;
  const RANK={user:0,preset:1,default:2};
  // A contextual command can run before presets while its tool owns the key. User bindings still win.
  const rank=r=>r.source==="user"?0:r.command.priority?1:RANK[r.source]+1;

  // ---------------------------------------------------------------- compile
  const TRUE=()=>true;
  function expand(spec,anyShift){
    const variants=spec.some(c=>c.mod)?(mac?[META,CTRL]:[CTRL,META]):[0],out=[];
    for(const v of variants){
      const seq=spec.map(c=>c.key*16+(c.mods|(c.mod?v:0)));out.push(seq);
      if(anyShift&&seq.length===1)out.push([seq[0]^SHIFT]);
    }
    return out;
  }
  function node(chord,depth,path){return {chord,depth,path,kids:[],children:null,bindings:[],any:[],desc:[]};}
  const available=cmd=>(!cmd.notebook||globalThis.AtriumLabs?.notebookEnabled()===true)&&globalThis.AtriumLabs?.allowsAction?.(cmd.action)!==false;
  function build(){
    const all=[],errors=[],byCommand=new Map(),byAction=new Map();
    for(const cmd of commands.values()){
      if(!available(cmd))continue;
      const {source,list}=effective(cmd.id),out=[];byCommand.set(cmd.id,out);
      list.forEach((x,i)=>{
        let spec,bw;
        try{spec=parse(x.key);bw=compileWhen(x.when);}catch(e){errors.push(cmd.id+": "+e.message);return;}
        const cw=cmd.whenTest,test=cw&&bw?(s,c)=>cw(s,c)&&bw(s,c):cw||bw||TRUE;
        const rec={uid:all.length,command:cmd,id:cmd.id,key:spec.map(chordText).join(" "),when:x.when||"",label:x.label,anyShift:!!x.anyShift,
          source,lead:!!x.lead,order:source==="default"?x.order??i:i,index:i,seqs:expand(spec,x.anyShift),test,repeatable:cmd.repeatable,inForms:cmd.inForms,bits:null};
        all.push(rec);out.push(rec);
        if(!byAction.has(cmd.action))byAction.set(cmd.action,[]);
        byAction.get(cmd.action).push(rec);
      });
    }
    const sorted=[...all].sort((a,b)=>rank(a)-rank(b)||a.order-b.order||a.command.order-b.command.order);
    const root=node(-1,0,[]);root.children=new Map();
    for(const rec of sorted)for(const seq of rec.seqs){
      let at=root;
      for(let d=0;d<seq.length;d++){
        if(!at.children){at.children=new Map();}
        let child=at.children.get(seq[d]);
        if(!child){child=node(seq[d],d+1,seq.slice(0,d+1));at.children.set(seq[d],child);at.kids.push(child);}
        at=child;
        if(!child.any.includes(rec))child.any.push(rec);
        if(d<seq.length-1){if(!child.desc.includes(rec))child.desc.push(rec);}
        else if(!child.bindings.includes(rec))child.bindings.push(rec);
      }
    }
    return {root:root.children,rootNode:root,all,byCommand,byAction,errors,bindingRevision};
  }
  function table(){return compiled||(compiled=build());}

  // ---------------------------------------------------------------- runtime helpers (no allocation)
  function firstPass(list,s,c,accept){for(let i=0;i<list.length;i++)if((!accept||accept(list[i]))&&list[i].test(s,c))return list[i];return null;}
  const anyPass=(list,s,c,accept)=>firstPass(list,s,c,accept)!==null;
  const live=(n,s,c,accept)=>anyPass(n.any,s,c,accept);
  const isPrefix=(n,s,c,accept)=>n.children!==null&&anyPass(n.desc,s,c,accept);
  function chordName(chord,spellComma){return joinKeys(chordKeys({key:chord>>4,mods:chord&15,mod:false},false,spellComma),false);}
  function prefixName(n){
    const plain=n.path.map(ch=>(ch&15)?chordName(ch):names[ch>>4]).join(" ");
    return PREFIX_NAMES[plain]||n.path.map(chord=>chordName(chord,n.path.length>1)).join(", ");
  }
  function labelOf(rec,kind){return rec.label||rec.command.short||rec.command.titles?.[kind]||rec.command.title;}
  function hintText(n,s,c,accept){
    const parts=[];
    for(const k of n.kids){
      if(isPrefix(k,s,c,accept))parts.push(chordName(k.chord)+" "+prefixName(k)+"…");
      else{const rec=firstPass(k.bindings,s,c,accept);if(rec)parts.push(chordName(k.chord)+" "+labelOf(rec,s.kind));}
    }
    return prefixName(n)+" · "+parts.join("   ");
  }

  // ---------------------------------------------------------------- analysis
  // Representative editor states. A binding's context is the set of states it accepts;
  // two bindings overlap when those sets intersect.
  let samples=null;
  function contexts(){
    if(samples)return samples;samples=[];
    const tools=["select","pan","route","route-diffpair","via","label","junction","place","move-object","measure","paste","length-tune"];
    for(const kind of ["pcb","schematic"])for(const tool of tools)for(const count of [0,1,2])for(const rotatable of [false,true])
      for(const canvas of [false,true])for(const cursorAt of [false,true])for(const view3d of kind==="pcb"&&tool==="select"?[false,true]:[false]){
        const routing=tool==="route"||tool==="route-diffpair";
        const state={kind,tool,interactive:!["select","pan"].includes(tool),selected:count>0,selectionCount:count,rotatable,canvas,cursorAt,view3d,
          canProperties:kind==="pcb"?routing||tool==="via":["place","label"].includes(tool),tuning:tool==="length-tune",documentId:"d",__assume:true,
          dragging:false,sticky:false,suggestion:false,suggestTab:false,busRouting:false};
        samples.push(state);
        if(tool==="select"&&!view3d&&count>0&&!rotatable)samples.push({...state,dragging:true},{...state,dragging:true,sticky:true});
        if(routing&&canvas&&kind==="pcb")samples.push({...state,suggestion:true},{...state,suggestion:true,suggestTab:true});
        if(tool==="route"&&kind==="pcb")samples.push({...state,busRouting:true});
      }
    return samples;
  }
  function bits(rec){
    if(rec.bits)return rec.bits;
    const ctx=contexts(),out=new Uint8Array(ctx.length);
    for(let i=0;i<ctx.length;i++)out[i]=rec.test(ctx[i],ctx[i].canvas)?1:0;
    return rec.bits=out;
  }
  function overlap(a,b){const x=bits(a),y=bits(b);for(let i=0;i<x.length;i++)if(x[i]&&y[i])return true;return false;}
  function kinds(rec){
    const x=bits(rec),ctx=contexts();let pcb=false,sch=false;
    for(let i=0;i<x.length;i++)if(x[i]){if(ctx[i].kind==="pcb")pcb=true;else sch=true;}
    return {pcb,schematic:sch};
  }
  const brief=rec=>({command:rec.id,title:rec.command.title,key:rec.key,when:rec.when,source:rec.source});
  // Same keys with overlapping contexts are conflicts; a sequence prefix that hides a
  // shorter binding is a shadow warning.
  function conflicts(){
    const t=table(),out=[],seen=new Set();
    function walk(n){
      if(n.bindings.length>1)for(let i=0;i<n.bindings.length;i++)for(let j=i+1;j<n.bindings.length;j++){
        const a=n.bindings[i],b=n.bindings[j];
        if(a.id===b.id||a.source!=="user"&&b.source!=="user"&&a.command.priority!==b.command.priority)continue;
        const tag="c"+Math.min(a.uid,b.uid)+"/"+Math.max(a.uid,b.uid);
        if(seen.has(tag)||!overlap(a,b))continue;seen.add(tag);
        out.push({type:"conflict",key:a.key,a:brief(a),b:brief(b),message:display(a.key,true)+" runs "+a.command.title+" and "+b.command.title+" in the same context."});
      }
      if(n.bindings.length&&n.desc.length)for(const a of n.bindings)for(const b of n.desc){
        if(a.lead)continue;
        const tag="s"+a.uid+"/"+b.uid;
        if(seen.has(tag)||!overlap(a,b))continue;seen.add(tag);
        out.push({type:"shadow",key:a.key,a:brief(a),b:brief(b),message:display(a.key,true)+" ("+a.command.title+") is hidden by the sequence "+display(b.key,true)+" ("+b.command.title+")."});
      }
      for(const k of n.kids)walk(k);
    }
    walk(t.rootNode);return out;
  }

  // ---------------------------------------------------------------- queries
  const IDLE={};
  for(const kind of ["pcb","schematic","drawing","panel"])IDLE[kind]={kind,tool:"select",interactive:false,selected:true,selectionCount:2,rotatable:false,canvas:true,cursorAt:false,canProperties:false,documentId:"d",suggestion:false,suggestTab:false};
  // A menu action may be implemented by a command with its own (namespaced) id.
  function hintKey(action,kind="schematic"){
    // Avoid showing another preset's binding while a saved preset is loading.
    if(!PRESETS[presetName])return "";
    const t=table(),list=t.byCommand.get(action)||[];
    const s=IDLE[kind]||IDLE.schematic;
    for(const rec of [...list,...(t.byAction.get(action)||[]).filter(r=>r.id!==action)]){
      if(!rec.test(s,true))continue;
      for(const seq of rec.seqs){
        const n=sequenceNode(t,seq,s,true);
        if(n&&(isPrefix(n,s,true)?leadOf(n,s,true):firstPass(n.bindings,s,true))?.id===rec.id){
          return seq===rec.seqs[0]?rec.key:seq.map(chord=>chordText({key:chord>>4,mods:chord&15})).join(" ");
        }
      }
    }
    return "";
  }
  const hintFor=(action,kind)=>display(hintKey(action,kind));
  // Parameterized menu entries and menu-only commands can have their own bindings.
  function menuHintKey(button,kind){
    const {action,powerNet}=button.dataset;
    if(powerNet!=null)return hintKey("power:"+powerNet,kind);
    const id="menu:"+action;
    return hintKey(action,kind)||(commands.has(id)?hintKey(id,kind):"");
  }
  function applyMenuHints(root,kind){
    const scopes=root==null?[globalThis.document]:Array.isArray(root)?root:[root];
    for(const scope of scopes)for(const n of scope?.querySelectorAll?.("[data-action]")||[]){
      const menu=n.closest?.(".menu-items");
      const key=menu?menuHintKey(n,kind):hintKey(n.dataset.action,kind);
      if(key){
        const visual=display(key),spoken=display(key,true);
        if(n.dataset.hint!==visual)n.dataset.hint=visual;
        if(n.getAttribute("aria-description")!==spoken)n.setAttribute("aria-description",spoken);
      }else if(n.dataset.hint){delete n.dataset.hint;n.removeAttribute("aria-description");}
      if(!menu)continue;
      const badge=n.querySelector(":scope > .ui-shortcut");
      if(!key)badge?.remove();
      else if(badge?.dataset.binding!==key || badge.dataset.visual!==n.dataset.hint){
        const node=globalThis.AtriumShortcut.render(key,{variant:"inline",node:badge??undefined});
        node.dataset.binding=key;node.dataset.visual=n.dataset.hint;node.setAttribute("aria-hidden","true");
        if(!badge)n.append(node);
      }
      if(mac)globalThis.AtriumHost?.macShortcutIntent?.();
    }
  }
  function sequenceNode(t,seq,s,c){
    let map=t.root,n=null;
    for(let i=0;i<seq.length;i++){
      n=map.get(seq[i]);if(!n)return null;
      if(i<seq.length-1){if(!isPrefix(n,s,c))return null;map=n.children;}
    }
    return n;
  }
  // Resolve key text using this platform's primary modifier for Mod.
  function resolve(text,state){
    const s={documentId:"d",...state},c=!!s.canvas,n=sequenceNode(table(),expand(parse(text),false)[0],s,c);
    if(!n)return null;
    if(isPrefix(n,s,c))return "prefix";
    return firstPass(n.bindings,s,c)?.id||null;
  }
  // A lead binding shares its key with a prefix (Modern: ⌘K opens the palette); editor-keys.js runs it.
  function leadOf(n,s,c,accept){for(const r of n?.bindings||[])if(r.lead&&(!accept||accept(r))&&r.test(s,c))return r;return null;}
  function cheatSheet(kind,raw=false){
    const t=table(),groups=new Map();
    for(const cmd of [...commands.values()].sort(byCategory)){
      const keys=(t.byCommand.get(cmd.id)||[]).filter(r=>kinds(r)[kind]).map(r=>raw?r.key:display(r.key));
      if(!keys.length)continue;
      if(!groups.has(cmd.category))groups.set(cmd.category,[]);
      groups.get(cmd.category).push({id:cmd.id,title:cmd.titles?.[kind]||cmd.title,keys});
    }
    return [...groups].map(([category,rows])=>({category,rows}));
  }
  function byCategory(a,b){
    const ca=CATEGORIES.indexOf(a.category),cb=CATEGORIES.indexOf(b.category);
    return (ca<0?99:ca)-(cb<0?99:cb)||a.order-b.order;
  }

  // ---------------------------------------------------------------- mutation API
  function bindingsFor(id){
    const {source,list}=effective(id);
    return list.map(x=>({key:normalize(x.key),when:x.when||"",source}));
  }
  function setBindings(id,list){
    if(list==null)user.delete(id);
    else user.set(id,list.map(x=>{const k=normalize(typeof x==="string"?x:x.key),w=typeof x==="string"?"":String(x.when||"");if(w)compileWhen(w);return {key:k,when:w};}));
    changed();
  }
  const current=id=>effective(id).list.map(x=>({key:x.key,when:x.when||""}));
  function addBinding(id,key,when){setBindings(id,[...current(id),{key,when:when??""}]);}
  function replaceBinding(id,index,key,when){const list=current(id);if(index<0||index>=list.length)return addBinding(id,key,when);list[index]={key,when:when??list[index].when};setBindings(id,list);}
  function removeBinding(id,index){const list=current(id);list.splice(index,1);setBindings(id,list);}
  function setWhen(id,index,when){const list=current(id);if(!list[index])return;compileWhen(when);list[index].when=String(when||"");setBindings(id,list);}
  function registerCommand(spec){
    if(!spec||typeof spec.id!=="string"||!spec.id)throw Error("A command needs an id.");
    if(commands.get(spec.id)?.builtin)throw Error("Command "+spec.id+" is built in.");
    addCommand({...spec,category:spec.category||"Extensions"},false);
    const keys=spec.defaultKeys==null?[]:Array.isArray(spec.defaultKeys)?spec.defaultKeys:[spec.defaultKeys];
    const list=keys.map((k,i)=>typeof k==="string"?{key:k,when:"",order:100000+i}:{key:k.key,when:k.when||"",order:100000+i});
    defaults.set(spec.id,list);
    changed(false);
    return {dispose(){unregisterCommand(spec.id);}};
  }
  function unregisterCommand(id){const c=commands.get(id);if(!c||c.builtin)return false;commands.delete(id);defaults.delete(id);changed(false);return true;}
  // Run a resolved binding: extension commands run themselves; editor commands go through
  // the editor's action switch.
  function invoke(rec,run){const c=rec.command;if(!available(c))return;if(c.run)c.run(c.param);else run(c.action,c.param);}

  // Load the shortcut recorder on first use.
  let openDialog=null;
  const editorInternals={presetName:()=>presetName,presetTitle,userCount:()=>user.size,effective,setOpen:d=>{openDialog=d;}};
  function open(ctx={}){
    if(openDialog){openDialog.querySelector("input[type=search]")?.focus();return openDialog;}
    const E=globalThis.AtriumKeymapEditor;
    if(E)return E.open(api,editorInternals,ctx);
    globalThis.AtriumLazy?.need?.("AtriumKeymapEditor").then(M=>{if(!openDialog)M.open(api,editorInternals,ctx);},say);
    return null;
  }

  load();
  globalThis.AtriumLabs?.onChange?.(()=>changed(false));

  // The native host reads the same command projection once its editor page is loaded.
  function documentFitRegistration(){
    return {action:fitDocument.action,title:fitDocument.title,key:fitDocument.nativeKey};
  }
  function documentFitEntry(){
    return [fitDocument.title,fitDocument.action];
  }

  const api={
    CTRL,SHIFT,ALT,META,MODS,MODIFIER,SPACE,ESCAPE,ENTER,
    eventKey,eventMask,impliesShift:k=>k>=0&&shifted[k],table,isPrefix,live,anyPass,firstPass,hintText,invoke,
    parse,normalize,display,displayParts,displayKeys,label,chordFromEvent,compileWhen,
    commands:()=>[...commands.values()].filter(available).sort(byCategory),command:id=>commands.get(id)||null,categories:()=>CATEGORIES.slice(),
    documentFitRegistration,documentFitEntry,documentFitBinding,
    registerCommand,unregisterCommand,
    bindingsFor,setBindings,addBinding,replaceBinding,removeBinding,setWhen,resetCommand:id=>setBindings(id,null),
    resetAll(){user=new Map();changed();},
    presets:()=>ORDER.filter(id=>PRESETS[id]||LAZY_PRESETS[id]).concat(Object.keys(PRESETS).filter(id=>!ORDER.includes(id))).map(id=>({id,title:presetTitle(id)})),preset:()=>presetName,
    setPreset(name){if(!Object.hasOwn(PRESETS,name)&&!Object.hasOwn(LAZY_PRESETS,name))throw Error("Unknown preset "+name+".");presetName=name;changed();if(!PRESETS[name])loadPresets();},
    definePreset,pendingPreset,leadOf,defaultBindings:id=>(defaults.get(id)||[]).map(x=>({...x})),
    sharedGroups:{placementPrefix:sharedPlace,schematicView:sharedSchView,tunePourSwap:sharedTune,toolsDesign:sharedTools,fitSplit:sharedFit,swapHelp:sharedSwapHelp,escapeToolTune:sharedEscape,liveRoute:sharedLiveRoute,deleteZoom:sharedDeleteZoom},
    isModified:id=>user.has(id),
    unregisteredBindings:()=>[...user.keys()].filter(id=>!commands.has(id)&&user.get(id).length),
    exportJSON:()=>JSON.stringify(data(),null,2),
    importJSON(text){return applyData(typeof text==="string"?JSON.parse(text):text);},
    conflicts,kinds,cheatSheet,hintKey,hintFor,menuHintKey,applyMenuHints,resolve,
    describeWhen:src=>globalThis.AtriumKeymapEditor?.describeWhen?.(src)??String(src??"").trim(),
    onChange(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    // Tests: choose the platform and a storage object.
    setPlatform(isMac){if(!!isMac!==mac)bindingRevision++;mac=!!isMac;compiled=null;markPlatform();},
    useStorage(s){bindingRevision++;storage=s;user=new Map();presetName="altium";load();changed(false);},
    get mac(){return mac;},
    open
  };
  return api;
})();
