"use strict";
// Lazy key-map presets (lazy.js loads this when one is chosen or was saved): Waffle Classic keeps the
// defaults from before the Altium chord pass whole (R rotates, + / − zoom, Ctrl+D layer controls,
// no E, A, C or U prefixes, literal Ctrl chords); KiCad-like builds on it. VS Code-like builds on the default.
globalThis.AtriumKeymapPresets = (() => {
  const K=globalThis.AtriumKeymap,b=(key,when="",extra)=>({key,when,...extra});
  const G=K.sharedGroups;
  // Commands only the Allegro-like and Modern (Mac) presets bind, registered here so the eager keymap.js stays small:
  // Save As, Done / Cancel and the command line (command-bar.js), document tabs 1…9 (vscode-keys.js; ⌘9 = last tab).
  const NEW_COMMANDS=[["save-as","Save as…","File"],["escape-done","Done (end the current command)","Edit","Done"],["escape-cancel","Cancel the current command","Edit","Cancel"],
    ["command-bar","Coordinate entry (x X Y, ix, iy)…","Edit","Coordinate entry"],
    ...[1,2,3,4,5,6,7,8,9].map(n=>["doc-tab-"+n,n<9?"Go to document tab "+n:"Go to the last document tab","Window",n<9?"Tab "+n:"Last tab"])];
  for(const [id,title,category,short] of NEW_COMMANDS)if(!K.command(id))K.registerCommand({id,title,category,...(short?{short}:{})});
  {
    const L=globalThis.AtriumLazy;
    L?.register?.("AtriumCommandBar",{scripts:["editor/command-bar.js"],css:["editor/command-bar.css"]},["command-bar","escape-done","escape-cancel"]);
    L?.register?.("AtriumVSKeys",{scripts:["editor/vscode-keys.js"],css:["editor/vscode-keys.css"],deps:["AtriumUIKit"]},[1,2,3,4,5,6,7,8,9].map(n=>"doc-tab-"+n));
    if(globalThis.document&&!globalThis.AtriumCommandBar)globalThis.AtriumNavCommon?.menuItem?.("edit","command-bar","Coordinate Entry…",{after:"goto-location"});
  }
  // [keys, command, when, hint label, any Shift] in hint order.
  const CLASSIC=[
    ...G.placementPrefix,
    ["Ctrl+Shift+M","measure-primitives","pcb","Measure primitives"],["D S E","board-edit-vertices","pcb","Edit board shape"],
    ...G.schematicView,
    ["X","mirror-x","schematic && (placing || dragging)"],["Y","mirror-y","schematic && (placing || dragging)"],["Mod+F","find-text","schematic"],["Mod+H","find-replace"],["Mod+R","rubber-stamp"],["D R","rules",null,"Design rules"],
    ...G.tunePourSwap,
    // Altium defaults (scripts/reachability.py lists the ones still missing): Tools » Design Rule Check,
    // Cross Probe, Annotate, Polygon Manager; Design » Layer Stack Manager, Update PCB, Classes.
    ...G.toolsDesign,
    ["Ctrl+M","measure"],["Ctrl+W","route","!routing"],["Ctrl+W","keep-routing","routing"],
    ["Mod+D","layer-controls","pcb"],["Mod+L","view-config","pcb"],
    ...G.fitSplit,K.documentFitBinding,
    ["Ctrl+Shift+G","grid","schematic"],["Mod+G","grid-custom"],
    ["Ctrl+Shift+L","align-left","selection"],["Ctrl+Shift+R","align-right","selection"],["Ctrl+Shift+T","align-top","selection"],
    ["Ctrl+Shift+B","align-bottom","selection"],["Ctrl+Shift+H","distribute-h","selection"],["Ctrl+Shift+V","distribute-v","selection"],
    ["Ctrl+Shift+D","align-grid","selection"],
    ...["left","right","up","down"].flatMap(d=>{const K=d[0].toUpperCase()+d.slice(1);
      return [["Ctrl+"+K,"nudge-"+d,"canvas && selection"],["Ctrl+Shift+"+K,"nudge-"+d+"-10","canvas && selection"]];}),
    ["Mod+S","save"],["Mod+O","open"],["Mod+P","print"],["Mod+Z","undo"],["Mod+Shift+Z","redo"],["Mod+Y","redo"],["Mod+Alt+Z","history"],["Mod+C","copy"],["Mod+V","paste"],
    ["Mod+A","select-all"],["S L","lasso-select","!placing"],["T W P","pin-swap","pcb"],["T W G","gate-swap","pcb"],["T W O","swap-optimise","pcb"],["Mod+D","duplicate","schematic"],["Mod+X","cut"],
    ...G.swapHelp,
    ["Mod+Shift+P","command-palette"],["F1","command-palette"],["/","insert-palette"],["J C","goto-object","","Component / net"],["J L","goto-location","","Location"],
    ["N","unrouted","pcb && !placing"],["F5","net-colours","pcb"],["Shift+F10","context-menu","canvas"],["ContextMenu","context-menu","canvas"],
    ...G.escapeToolTune,
    // Interactive routing (Altium): Shift+R conflict mode, * next layer, 2 via, 3 width, 4 via size, , . arc radius.
    ["Shift+R","route-conflict","routing"],["*","route-layer-next","routing"],["2","route-via","routing"],["3","route-width","routing"],
    ...G.liveRoute,
    ...["left","right","up","down"].flatMap(d=>{const K=d[0].toUpperCase()+d.slice(1);
      return [[K,"cursor-"+d,"canvas"],["Shift+"+K,"cursor-"+d+"-10","canvas"]];}),
    ...G.deleteZoom,
    ["L","flip-side","pcb && (moving || tool == place || dragging)"],["L","view-config","pcb && !placing && !dragging"],["Shift+F","find-similar","(pcb || schematic) && selection && !placing"],["Shift+H","hud","pcb"],["Ctrl+F","flip-board","pcb && canvas"],["Shift+E","snap-object","pcb"],["1","view-planning","pcb && !routing && !tuning && !placing"],["2","view-2d","pcb && !routing && !tuning && !placing"],["3","view-3d","pcb && !routing && !tuning && !placing"],["F12","query-panel"],["Shift+C","query-clear"],["Shift+S","layer-mode","pcb"],["Shift+G","grid-prev","!pcb"],
    ["W","route","!routing"],["H","pan"],["L","label","!pcb && !placing"],["R","rotate","!moving"],["R","rotate-cw","moving && rotatable"],
    ["F","fit","!view3d"],["0","view3d-top","view3d"],["9","view3d-bottom","view3d"],["F","view3d-flip","view3d"],["G","grid-picker","pcb"],["G","grid-next","!pcb"],["Q","toggle-units"],["+","zoom-in"],["-","zoom-out"]
  ];
  K.definePreset("classic",{title:"Waffle Classic",table:CLASSIC});
  K.definePreset("kicad",{title:"KiCad-like",base:"classic",bindings:{
      // KiCad single keys; the Altium Place sequences stay available.
      library:[b("A","!placing"),b("P P","schematic"),b("P C","pcb")],
      route:[b("W","schematic && !routing"),b("X","pcb && !routing"),b("Ctrl+W","!routing"),b("P W","schematic"),b("P T","pcb")],
      via:[b("Mod+Shift+V","pcb"),b("P V","pcb")],"align-top":[b("Ctrl+Shift+T","selection && !pcb")],"distribute-v":[b("Ctrl+Shift+V","selection && !pcb")],label:[b("L","schematic && !placing"),b("Mod+Shift+T","pcb"),b("P N","schematic"),b("P S","pcb")],
      junction:[b("J","schematic && !placing"),b("P J","schematic")],
      "move-object":[b("M","!placing")],deselect:[],measure:[b("Mod+Shift+M")],"measure-primitives":[],fit:[b("Home")],"fit-objects":[b("Mod+Home")],
      "zoom-in":[b("+")],"zoom-out":[b("F2"),b("-")],shortcuts:[b("Mod+F1"),b("?")],
      "grid-next":[b("N","!routing")],"grid-prev":[b("Shift+N","!routing")],"grid-picker":[],"toggle-units":[b("Mod+U")],
      "swap-components":[b("Alt+S"),b("Mod+Alt+S")],cheatsheet:[b("Mod+?"),b("Mod+Shift+/")],unrouted:[],"goto-object":[],"goto-location":[],"command-palette":[b("Mod+Shift+P"),b("F1")]
    }});
  // VS Code-like: VS Code meanings everywhere, built on the Altium-style default (which already has
  // the VS Code keys that clash with nothing). Each decision is listed in VSCODE_DECISIONS and in
  // docs/shortcuts.md ("VS Code keys"); tests/keymap.cjs checks the preset has no conflicts.
  K.definePreset("vscode",{title:"VS Code-like",base:"altium",bindings:{
    "quick-open":[b("Mod+P"),b("Mod+E")],print:[],
    "goto-location":[b("Mod+G"),b("J L","",{label:"Location"})],"grid-custom":[],
    "goto-object":[b("Mod+Shift+O"),b("Mod+T"),b("J C","",{label:"Component / net"})],"flip-board":[b("V B","pcb",{label:"Flip board"})],
    "close-document":[b("Mod+W","!routing"),b("Mod+F4")],"start-wire":[],route:[b("P W","schematic",{label:"Wire"}),b("P T","pcb",{label:"Route track"}),b("W","!routing")],
    "keep-routing":[b("Ctrl+W","routing")],
    "reopen-document":[b("Mod+Shift+T")],"align-top":[b("A T","",{label:"Top"}),b("E G T","",{label:"Top"})],
    messages:[b("Mod+J"),b("Mod+Shift+M")],"measure-primitives":[b("R P","pcb",{label:"Measure primitives"})],
    "find-replace":[b("Mod+Shift+F"),b("Mod+Alt+F"),b("Ctrl+H","schematic")],
    "doc-next":[b("Ctrl+Tab"),b("Mod+PageDown"),b("Mod+Alt+Right")],"doc-prev":[b("Ctrl+Shift+Tab"),b("Mod+PageUp"),b("Mod+Alt+Left")],
    "fit-document":[b("V D","",{label:"Fit document"}),b(K.documentFitBinding[0])],"fit-objects":[b("V F","",{label:"Fit objects"})],
    shortcuts:[b("Mod+K Mod+H"),b("Shift+F1"),b("?")]
  }});
  // [key, VS Code meaning, Altium-style default, VS Code-like preset, why]. Rendered into docs/shortcuts.md.
  const VSCODE_DECISIONS=[
    ["Mod+Shift+P / F1","Command palette","Command palette","Command palette","Same meaning everywhere."],
    ["Mod+P","Quick open","Quick open","Quick open","Quick open lists the project's documents and recent files (2026-11-23; was Print, as in Altium). Print stays on File › Print…."],
    ["Mod+E","Quick open (Windows)","—","Quick open",""],
    ["Mod+Shift+O","Go to symbol in editor","Jump to object","Jump to object","Free in Altium: added to the default."],
    ["Mod+T","Go to symbol in workspace","—","Jump to object",""],
    ["Mod+G","Go to line","Set snap grid (Altium)","Jump to location","The default keeps Altium's grid; Jump to Location is also J L."],
    ["Mod+F","Find","Find in project","Find in project","The palette, filtered to the project's objects, nets, designators, labels and text (2026-11-23; was Find text on sheets and Flip board on boards). Flip Board stays on V B."],
    ["Mod+H / Mod+Alt+F","Replace","Select net (boards) / Find and replace (sheets)","Find and replace (Ctrl+H on sheets, Mod+Alt+F everywhere)","Ctrl+H keeps Altium's Select Net on boards."],
    ["Mod+Shift+F","Search","Find and replace","Find and replace","Waffle's project-wide find and replace is its Search view."],
    ["Mod+B","Toggle primary side bar","Projects panel","Projects panel","Free in Altium."],
    ["Mod+Alt+B","Toggle secondary side bar","Properties panel","Properties panel","Free in Altium."],
    ["Mod+J","Toggle panel","Messages panel","Messages panel","The bottom panel is Messages."],
    ["Mod+Shift+M","Problems","Measure primitives (Altium)","Messages panel","Measure Primitives stays on R P."],
    ["Mod+,","Settings","Preferences","Preferences",""],
    ["Mod+K Mod+S","Keyboard shortcuts","Keyboard shortcuts","Keyboard shortcuts",""],
    ["Mod+K Mod+T","Color theme","Color theme picker","Color theme picker",""],
    ["Mod+K Z","Zen mode","Zen mode","Zen mode","Owned by the docking work (dock.js)."],
    ["Mod+K ←/→, F6","Focus editor group","Focus pane / part","Focus pane / part",""],
    ["Mod+K W","Close editor group","Close split","Close split",""],
    ["Mod+1…9","Focus editor group N","Selection memory","Selection memory","Reserved for selection memory (store); panes use Mod+K ←/→ and F6."],
    ["Ctrl+Tab / Ctrl+Shift+Tab","Quick switch editors","Document switcher","Document switcher","Hold Ctrl and tap Tab; release to switch."],
    ["Mod+Alt+→ / ←","Next / previous editor","Next / previous document","Next / previous document",""],
    ["Mod+PageDown / PageUp","Next / previous editor","Fit document / fit objects (Altium)","Next / previous document","Fit stays on V D and V F."],
    ["Mod+W","Close editor","— (⌘W is the window; Ctrl+W routes, Altium)","Close document tab (not while routing)","Ctrl+W keeps routing while a route is live; P T and W still route."],
    ["Mod+F4","Close editor (Windows/Linux)","Close document tab","Close document tab",""],
    ["Mod+Shift+T","Reopen closed editor","Align top (Altium)","Reopen closed document tab","Align Top stays on A T and E G T."],
    ["Mod+Shift+E","Explorer","Focus Projects","Focus Projects",""],
    ["Mod+Shift+X","Extensions","Extensions","Extensions",""],
    ["Ctrl+`","Terminal","Scripting console","Scripting console",""],
    ["F2","Rename symbol","Rename designator or net","Rename designator or net","Opens the Properties field; not while placing."],
    ["Mod+= / Mod+- / Mod+0","Zoom in / out / reset","Zoom in / out / fit","Zoom in / out / fit",""],
    ["Mod+N","New file","New project","New project",""],
    ["Mod+? (Mod+Shift+/)","Keyboard shortcuts reference","Cheat sheet overlay","Cheat sheet overlay","Also in KiCad-like. Waffle Classic keeps its frozen table (Help menu and palette)."],
    ["Mod+D","Add next occurrence","Duplicate (Altium)","Duplicate","Not applicable to a canvas; Altium kept."],
    ["Mod+L","Expand line selection","View configuration (Altium)","View configuration","Not applicable; Altium kept."],
    ["Mod+R","Open recent","Rubber stamp (Altium)","Rubber stamp","Recent files are in Quick open (Mod+P)."],
    ["Alt+← / Alt+→","Go back / forward","Previous / next view","Previous / next view","Same idea: view history."],
    ["F8 / Shift+F8","Next / previous problem","Next / previous violation","Next / previous violation",""]
  ];
  // Allegro-like (Cadence Allegro PCB Editor habits), built on the Altium-style default: the function keys of
  // Allegro's stock env file, Ctrl+R rotate (the usual `alias ~R angle 90`), and X opens the command line for
  // typed coordinates (x X Y, ix DX, iy DY; command-bar.js). Each mapping, and each Allegro feature with no
  // Waffle equivalent, is in ALLEGRO_DECISIONS and docs/shortcuts.md ("Allegro keys").
  const dflt=id=>K.defaultBindings?K.defaultBindings(id):[],plus=(id,...extra)=>[...extra,...dflt(id)],minus=(id,re)=>dflt(id).filter(x=>!re.test(x.key));
  const ALLEGRO={
    fit:plus("fit",b("F2","",{label:"Zoom fit"})),route:plus("route",b("F3","!routing",{label:"Add connect"})),
    "toggle-right":plus("toggle-right",b("F4","",{label:"Show element"})),"net-colours":minus("net-colours",/^F5$/),
    "escape-done":[b("F6","",{label:"Done"})],"focus-part-next":minus("focus-part-next",/^F6$/),
    "route-back":plus("route-back",b("F7","routing",{label:"Oops"})),undo:plus("undo",b("F7","!routing",{label:"Oops"})),
    "escape-cancel":[b("F8","",{label:"Cancel"}),b("F9","",{label:"Cancel"})],"drc-next":minus("drc-next",/^F8$/),"drc-prev":minus("drc-prev",/^Shift\+F8$/),
    grid:plus("grid",b("F10","",{label:"Grid toggle"})),"zoom-in":plus("zoom-in",b("F11","",{label:"Zoom in"})),
    "zoom-out":plus("zoom-out",b("F12","",{label:"Zoom out"})),"query-panel":minus("query-panel",/^F12$/),"rename-object":minus("rename-object",/^F2$/),
    "rotate-ccw":plus("rotate-ccw",b("Ctrl+R","rotatable && !routing",{label:"Rotate 90°"})),"rubber-stamp":[b("Mod+R","!rotatable")],
    "command-bar":[b("X","pcb || !placing && !dragging",{label:"x coordinates"})],deselect:[b("Mod+Shift+A")]
  };
  K.definePreset("allegro",{title:"Allegro-like",base:"altium",bindings:ALLEGRO});
  // [Allegro key or command, Allegro meaning, Waffle key in this preset, Waffle command, notes]. "—" = no equivalent.
  const ALLEGRO_DECISIONS=[
    ["F2","zoom fit","F2","Fit design","F also fits the design. Mod+0 fits the document."],
    ["F3","add connect","F3","Route (track on boards, wire on sheets)","P T, W and Ctrl+W still route."],
    ["F4","show element","F4","Properties panel","Waffle shows the picked object's details in Properties instead of a report window."],
    ["F5","redraw","—","—","Waffle redraws continuously; there is nothing to refresh. F5 is left free (the default's Net colour override is on View)."],
    ["F6","done","F6","Done: end the current command","Commits what the command has made and returns to Select (a route is kept, a placement is ended)."],
    ["F7","oops","F7","Retract the last routing click; Undo otherwise","Backspace still retracts while routing."],
    ["F8, F9","cancel","F8, F9","Cancel the current command","Discards the unfinished route or placement and returns to Select. Next Violation stays on Tools."],
    ["F10","grid toggle","F10","Toggle visible grid",""],
    ["F11, F12","zoom in, zoom out","F11, F12","Zoom in, zoom out","On macOS, F11 is Show Desktop unless the function keys are set to standard function keys."],
    ["Ctrl+R","rotate 90° while moving (alias ~R angle 90)","Ctrl+R","Rotate counterclockwise","Only while something can rotate; Ctrl/⌘+R stays Rubber stamp otherwise."],
    ["x X Y","pick at an absolute coordinate","X, then x X Y","Coordinate entry (command line)","Typed during placement or routing; the point snaps like a click. Edit › Coordinate Entry… opens it too."],
    ["ix DX, iy DY","pick relative to the last pick","X, then ix / iy / ixy","Coordinate entry (command line)","Relative to the last point you clicked or entered."],
    ["Right-click › Done / Oops / Cancel","finish, undo a pick, abort","F6 / F7 / F8","Done / Oops / Cancel","Waffle's right-click ends the current stage, as in Altium; the Allegro pop-up menu is not reproduced."],
    ["Right-click › Next","next candidate under the pointer","—","—","No equivalent: click again to cycle overlapping objects."],
    ["Strokes (right-drag gestures)","stroke commands (copy, move, zoom, undo…)","—","—","Right-drag pans in Waffle; there is no stroke recogniser."],
    ["Typed commands (add connect, slide, move, delete, show element, zoom fit…)","the command console","X, then the command","The command line maps the common ones","add connect, slide, move, delete, show element, show measure, zoom fit/in/out, grid toggle, undo, redo, done, oops, cancel. Anything else: the command palette."],
    ["Environment aliases / funckey","user key bindings in the env file","—","Tools › Keyboard Shortcuts…","Waffle imports VS Code keybindings, not Allegro env files."],
    ["Design Workflow / Options, Find and Visibility panes","the right-hand panes","—","Properties, Filter and View Configuration panels","Not key bindings."]
  ];
  // Modern (Mac): ⌘-centric, single letters for tools as in Figma, no two-key Altium sequences; rare commands on
  // ⌘K ⌘<key> chords (⌘K alone opens the command palette at once; the palette then takes the second ⌘ key).
  // Design and rationale: docs/keymap-modern-mac.md (generated from MODERN and MODERN_WHY by gen-shortcuts.py).
  const LEAD={lead:true},SEL="selection && !placing",PCB_IDLE="pcb && !placing",SCH_IDLE="schematic && !placing";
  const MODERN=[
    // App and file (macOS conventions).
    ["Mod+N","new"],["Mod+O","open"],["Mod+S","save"],["Mod+Shift+S","save-as"],["Mod+P","print"],["Mod+W","close-document"],["Mod+Shift+T","reopen-document"],
    // Command palette: ⌘K (lead of the ⌘K chords) and ⇧⌘P.
    ["Mod+K","command-palette","",null,false,LEAD],["Mod+Shift+P","command-palette"],["F1","command-palette"],["/","search"],["Mod+Shift+O","quick-open"],
    // Edit.
    ["Mod+Z","undo"],["Mod+Shift+Z","redo"],["Mod+Y","redo"],["Mod+Alt+Z","history"],["Mod+X","cut"],["Mod+C","copy"],["Mod+V","paste"],["Mod+Shift+V","paste-special"],["Mod+Alt+V","clipboard-picker"],
    ["Mod+A","select-all"],["Mod+Shift+A","deselect"],["Mod+D","duplicate"],
    ["Backspace","delete","!placing && selection",null,true],["Delete","delete","!placing && selection",null,true],
    ["Backspace","route-back","routing",null,true],["Delete","route-back","routing",null,true],["Escape","escape","",null,true],
    ["Mod+F","find"],["Mod+Shift+F","find-replace"],["Mod+E","find-similar",SEL],
    ["Mod+L","goto-location","!placing"],["Mod+L","command-bar","placing"],
    ["Mod+G","union-create","pcb && selection"],["Mod+Shift+G","union-break","pcb && selection"],["Mod+Shift+L","lock","pcb && selection"],["Mod+Alt+Shift+L","unlock","pcb && selection"],
    ["Enter","rename-object","canvas && selection && !placing && !cursorAt"],
    // Align (Figma: ⌥A ⌥D ⌥W ⌥S ⌥H ⌥V).
    ["Alt+A","align-left","selection"],["Alt+D","align-right","selection"],["Alt+W","align-top","selection"],["Alt+S","align-bottom","selection"],
    ["Alt+H","align-hcenter","selection"],["Alt+V","align-vcenter","selection"],["Alt+Shift+H","distribute-h","selection"],["Alt+Shift+V","distribute-v","selection"],["Alt+G","align-grid","selection"],
    // Rotate and flip.
    ["R","rotate-ccw","rotatable && !routing && (placing || dragging)"],["Shift+R","rotate-cw","rotatable && !routing && (placing || dragging)"],
    ["Mod+R","rotate-ccw","rotatable && !routing"],["Mod+Shift+R","rotate-cw","rotatable && !routing"],
    ["F","flip-side","pcb && !view3d && (selection || placing || dragging)"],
    ["Shift+H","mirror-x","schematic && (selection || placing || dragging)"],["Shift+V","mirror-y","schematic && (selection || placing || dragging)"],
    // Tools: one letter each, as in Figma (V move, H hand).
    ["V","select","!routing","Select"],["H","pan","","Hand (pan)"],["R","route","!placing && !dragging","Route"],["W","route","!placing && !dragging","Wire"],
    ["P","library","!placing","Place part"],["Shift+P","polygon-pour",PCB_IDLE,"Polygon pour"],["Shift+P","sch-power",SCH_IDLE,"Power port"],
    ["N","label",SCH_IDLE,"Net label"],["N","unrouted",PCB_IDLE,"Unrouted connections"],["T","sch-text",SCH_IDLE,"Text"],["T","label",PCB_IDLE,"Text (string)"],
    ["J","junction",SCH_IDLE,"Junction"],["B","sch-bus",SCH_IDLE,"Bus"],["Shift+V","via",PCB_IDLE,"Via"],["D","route-diffpair",PCB_IDLE,"Differential pair"],
    ["U","length-tune",PCB_IDLE,"Length tuning"],["Shift+U","length-tune-pair",PCB_IDLE,"Diff pair tuning"],
    ["M","measure","!placing","Measure"],["Shift+M","measure-primitives",PCB_IDLE,"Measure clearance"],["L","view-config",PCB_IDLE,"Layers"],
    ["C","comment-mode","!placing","Comment"],["Shift+L","lasso-select","!placing","Lasso"],["G","grid-next","","Next snap grid"],["Shift+G","grid-prev","","Previous snap grid"],["Shift+C","query-clear"],
    // View.
    ["Mod+=","zoom-in"],["Mod++","zoom-in"],["Mod+-","zoom-out"],K.documentFitBinding,["+","zoom-in"],["-","zoom-out"],["PageUp","zoom-in-pointer"],["PageDown","zoom-out-pointer"],
    ["Mod+[","view-back"],["Mod+]","view-forward"],["]","layer-next","pcb && !tuning"],["[","layer-prev","pcb && !tuning"],["*","layer-signal-next","pcb"],
    ["1","view-planning","pcb && !routing && !tuning && !placing"],["2","view-2d","pcb && !routing && !tuning && !placing"],["3","view-3d","pcb && !routing && !tuning && !placing"],
    ["0","view3d-top","view3d"],["9","view3d-bottom","view3d"],["F","view3d-flip","view3d"],
    // Panels and windows.
    ["Mod+B","toggle-left"],["Mod+Alt+I","toggle-right"],["Mod+I","toggle-right"],["Mod+J","messages"],["Mod+\\","split-toggle"],["Mod+Alt+\\","split-counterpart"],
    ["Ctrl+`","toggle-console"],["Mod+Shift+E","focus-projects"],["Mod+Shift+X","focus-extensions"],
    ["Ctrl+Tab","doc-next"],["Ctrl+Shift+Tab","doc-prev"],["Mod+}","doc-next"],["Mod+Shift+]","doc-next"],["Mod+{","doc-prev"],["Mod+Shift+[","doc-prev"],
    ...[1,2,3,4,5,6,7,8,9].map(n=>["Mod+"+n,"doc-tab-"+n]),
    ["Mod+?","cheatsheet"],["Mod+Shift+/","cheatsheet"],["Mod+'","drc-next","pcb"],["Mod+\"","drc-prev","pcb"],["Mod+Shift+'","drc-prev","pcb"],
    // Rare commands: ⌘K, then ⌘ and a letter.
    ["Mod+K Mod+T","theme-picker","","Color theme"],["Mod+K Mod+S","keyboard-shortcuts","","Keyboard shortcuts"],["Mod+K Mod+Z","zen-mode","","Zen mode"],
    ["Mod+K Mod+U","toggle-units","","Units (mm / mil)"],["Mod+K Mod+G","grid-picker","","Snap grid…"],["Mod+K Mod+Shift+G","grid","","Show grid"],
    ["Mod+K Mod+R","rules","","Design rules"],["Mod+K Mod+L","stackup","pcb","Layer stack"],["Mod+K Mod+D","drc","","Design rule check"],["Mod+K Mod+E","compile","","Compile (ERC)"],
    ["Mod+K Mod+P","eco","","Update PCB"],["Mod+K Mod+B","bom","","Bill of materials"],["Mod+K Mod+A","annotate","schematic","Annotate"],["Mod+K Mod+X","cross-probe","","Cross probe"],
    ["Mod+K Mod+F","flip-board","pcb","Flip board view"],["Mod+K Mod+W","split-close","","Close split"],["Mod+K Mod+]","focus-pane-next","","Next pane"],["Mod+K Mod+[","focus-pane-prev","","Previous pane"],
    // Routing (inside a live route).
    ["Shift+Space","route-bend","routing"],["M","route-mode","routing"],["V","route-via","routing"],["2","route-via","routing"],["3","route-width","routing"],["4","route-via-size","routing"],
    ["W","route-width-pick","routing"],["Shift+V","route-via-pick","routing"],["Shift+R","route-conflict","routing"],[".","route-arc-larger","routing"],[",","route-arc-smaller","routing"],
    ["Tab","tool-properties","canvas && canProperties"],
    ["1","length-amplitude-down","tuning"],["2","length-amplitude-up","tuning"],["3","length-gap-down","tuning"],["4","length-gap-up","tuning"],
    [",","length-miter-down","tuning"],[".","length-miter-up","tuning"],["Tab","length-properties","tuning"],["[","length-rounding-down","tuning"],["]","length-rounding-up","tuning"],
    ["Shift+Space","move-corner-mode","(dragging || sticky) && !routing && !rotatable"],["Tab","move-properties","canvas && (dragging || sticky) && !canProperties && !tuning"],
    // Arrows nudge the selection (Figma), step the cursor while placing, and pan the view otherwise. Space held pans (Figma).
    ...["left","right","up","down"].flatMap(d=>{const A=d[0].toUpperCase()+d.slice(1);
      return [[A,"nudge-"+d,"canvas && "+SEL],["Shift+"+A,"nudge-"+d+"-10","canvas && "+SEL],[A,"cursor-"+d,"canvas && placing"],["Shift+"+A,"cursor-"+d+"-10","canvas && placing"],
        [A,"camera-pan-"+d,"canvas && !selection && !placing"],["Shift+"+A,"camera-pan-"+d+"-fast","canvas && !selection && !placing"]];}),
    ["Space","pan-hold"],
    ["Enter","place-at-pointer","canvas && placing",null,true],["Enter","select-at-pointer","canvas && !placing && cursorAt && tool == select",null,true],
    ["Shift+F10","context-menu","canvas"],["ContextMenu","context-menu","canvas"]
  ];
  // Commands registered by modules (not built in) keep their own default keys in every preset; these would bring
  // Altium sequences (P M, D M M …) back, so the Modern preset rebinds or clears them.
  const MODERN_MODULES={preferences:[b("Mod+,")],"ai.askSelection":[b("Mod+Alt+Shift+I")],"bus:route-bus":[b("Shift+B","pcb",{label:"Bus routing"})],
    "rooms:room-move":[],"rooms:rooms-fit":[],"multichannel:room-replicate":[],"multichannel:mc-sync":[],
    "library:library-panel":[b("Mod+Alt+P","",{label:"Library (parts)"})],"library:footprint-wizard":[],"library:footprint-editor":[],"library:symbol-editor":[]};
  K.definePreset("modern",{title:"Modern (Mac)",table:MODERN,bindings:MODERN_MODULES});
  // Why each Modern binding is what it is, by key (docs/keymap-modern-mac.md). Keys not listed take their command's note.
  const MODERN_WHY={
    "F1":"Open the command palette.","/":"Search everything (commands, objects, documents).",
    "Mod+N":"macOS: New.","Mod+O":"macOS: Open.","Mod+S":"macOS: Save (repeated ⌘S is safe: incremental save).","Mod+Shift+S":"macOS: Save As / Duplicate.",
    "Mod+P":"macOS: Print stays standard. Quick open moves to ⇧⌘O.","Mod+W":"Tabbed Mac apps (Safari, Xcode): ⌘W closes the tab, in every context (a placement is cancelled first), so it never reaches the window's Close and quits.","Mod+Shift+T":"Safari and browsers: reopen the closed tab.",
    "Mod+K":"Linear, Raycast, Figma, Slack: ⌘K is the command palette. It opens at once; the next ⌘ key runs a ⌘K chord (VS Code style).","Mod+Shift+P":"VS Code alias for the palette.",
    "Mod+Shift+O":"Xcode: Open Quickly.","Mod+Z":"macOS: Undo.","Mod+Shift+Z":"macOS: Redo.","Mod+Y":"PC fallback: Ctrl+Y redo (⌘Y is free on macOS).","Mod+Alt+Z":"Open History beside Undo and Redo.",
    "Mod+X":"macOS: Cut.","Mod+C":"macOS: Copy.","Mod+V":"macOS: Paste.","Mod+Shift+V":"Paste Special (Mac apps use ⇧⌘V for a special paste).","Mod+Alt+V":"Clipboard history: the visual clipboard.",
    "Mod+A":"macOS: Select All.","Mod+Shift+A":"Deselect (Illustrator, Affinity).","Mod+D":"Figma, Sketch: Duplicate.",
    "Backspace":"Delete the selection; while routing, retract the last click.","Delete":"As Backspace.","Escape":"Cancel or end the current stage; again returns to Select.",
    "Mod+F":"macOS: Find. Finds in the project: designators, nets, pins, labels and text.","Mod+Shift+F":"VS Code, Xcode: find in project (find and replace across documents).",
    "Mod+E":"macOS: Use Selection for Find. Here: find objects similar to the selection.","Mod+L":"Safari: the location bar; Xcode: go to line. Idle: jump to a location. While placing or routing: type the next point.",
    "Mod+G":"Figma, Sketch: Group. Boards: create a union. Waffle has no incremental find, so Find Next has nothing to repeat.","Mod+Shift+G":"Figma, Sketch: Ungroup (break the union).",
    "Mod+Shift+L":"Figma: Lock.","Mod+Alt+Shift+L":"Unlock (Waffle keeps Lock and Unlock separate).","Enter":"Finder: Return renames. With a selection, Enter edits its designator or net; while placing, it places at the keyboard cursor.",
    "Alt+A":"Figma: align left.","Alt+D":"Figma: align right.","Alt+W":"Figma: align top.","Alt+S":"Figma: align bottom.","Alt+H":"Figma: align horizontal centres.","Alt+V":"Figma: align vertical centres.",
    "Alt+Shift+H":"Distribute horizontally (Figma's ⌃⌥H would be AltGr on European PC layouts).","Alt+Shift+V":"Distribute vertically.","Alt+G":"Align to grid.",
    "R":"Route (Figma-style tool letter). While placing or moving something that rotates, R rotates it.","Shift+R":"Rotate the other way while placing; routing conflict mode while routing.",
    "Mod+R":"Rotate the selection without picking it up.","Mod+Shift+R":"Rotate the selection clockwise.","F":"KiCad: F flips a part to the other side. In 3D, flip the view.",
    "Shift+H":"Figma: flip horizontal (schematic mirror X).","Shift+V":"Figma: flip vertical (schematic mirror Y); on boards, the via tool; while routing, the via size chooser.",
    "V":"Figma: V is the move/select tool. While routing, V adds a via (KiCad).","H":"Figma: H is the hand tool.","W":"Wire (both editors run the route tool). While routing, W chooses the track width.",
    "P":"Place a component from the library.","Shift+P":"Boards: polygon pour. Sheets: power port.","N":"Sheets: net label. Boards: show unrouted connections.","T":"Text (sheets: text string; boards: string).",
    "J":"Junction.","B":"Bus.","Shift+B":"Bus routing.","D":"Differential pair routing.","U":"Length tuning (tune).","Shift+U":"Differential pair length tuning.",
    "M":"Measure. While routing, M cycles the corner mode (90°, 45°, free).","Shift+M":"Measure clearance between primitives.","L":"Layers (View Configuration).",
    "C":"Figma: C is comments (annotate mode).","Shift+L":"Lasso select.","G":"Next snap grid.","Shift+G":"Previous snap grid.","Shift+C":"Clear the filter and net highlight.",
    "Mod+=":"macOS: Zoom In.","Mod++":"As ⌘=.","Mod+-":"macOS: Zoom Out.","Mod+0":"The native View › Fit Document shortcut.","+":"Figma: + zooms in.","-":"Figma: − zooms out.",
    "PageUp":"Zoom in at the cursor.","PageDown":"Zoom out at the cursor.","Mod+[":"Safari, Finder, Xcode: Back (view history).","Mod+]":"Forward (view history).",
    "]":"Figma: ] and [ move through layers. Next copper layer (also while routing).","[":"Previous copper layer.","*":"Next signal layer (Altium's numpad *).",
    "1":"Board planning mode.","2":"2D layout. While routing, add a via (Altium 2).","3":"3D view. While routing, next track width.","4":"While routing, next via size.",
    "0":"3D: view from the top.","9":"3D: view from the bottom.",
    "Mod+B":"VS Code, Xcode: toggle the left side bar (Projects).","Mod+Alt+I":"Safari, Chrome: ⌥⌘I is the inspector. Properties panel.","Mod+I":"Finder: Get Info. Properties panel.",
    "Mod+J":"VS Code: toggle the bottom panel (Messages).","Mod+\\":"VS Code: split the editor.","Mod+Alt+\\":"Split with the counterpart (board beside its schematic).",
    "Ctrl+`":"VS Code: the terminal (scripting console). ⌘` is macOS window cycling, so this stays on Control.","Mod+Shift+E":"VS Code: Explorer (Projects).","Mod+Shift+X":"VS Code: Extensions.",
    "Ctrl+Tab":"Safari: next tab.","Ctrl+Shift+Tab":"Safari: previous tab.","Mod+}":"Safari, Xcode, Terminal: ⌘} next tab.","Mod+Shift+]":"As ⌘}.","Mod+{":"Safari, Xcode, Terminal: ⌘{ previous tab.","Mod+Shift+[":"As ⌘{.",
    "Mod+1":"Safari, Chrome: ⌘1…⌘8 go to that tab, ⌘9 to the last.","Mod+?":"macOS Help shortcut: the keyboard cheat sheet.","Mod+Shift+/":"As ⌘?.",
    "Mod+'":"Xcode: ⌘' next issue (next DRC violation).","Mod+\"":"Xcode: ⌘\" previous issue.","Mod+Shift+'":"As ⌘\".",
    "Mod+K Mod+T":"VS Code: color theme.","Mod+K Mod+S":"VS Code: keyboard shortcuts.","Mod+K Mod+Z":"Zen mode (VS Code uses ⌘K Z; here every second key takes ⌘).",
    "Mod+K Mod+U":"Units (mm / mil).","Mod+K Mod+G":"Choose the snap grid.","Mod+K Mod+Shift+G":"Show or hide the grid.","Mod+K Mod+R":"Design rules.","Mod+K Mod+L":"Layer stack manager.",
    "Mod+K Mod+D":"Design rule check.","Mod+K Mod+E":"Compile (electrical rules).","Mod+K Mod+P":"Update the PCB from the schematics (ECO).","Mod+K Mod+B":"Bill of materials.",
    "Mod+K Mod+A":"Annotate schematics.","Mod+K Mod+X":"Cross probe to the other document.","Mod+K Mod+F":"Flip the board view.","Mod+K Mod+W":"VS Code: ⌘K W closes the split.",
    "Mod+K Mod+]":"Focus the next pane (VS Code uses ⌘K → , but ⌘ arrows would be Ctrl arrows on a PC, which macOS keeps for Spaces).","Mod+Alt+P":"Library panel (parts).","Mod+K Mod+[":"Focus the previous pane.",
    "Shift+Space":"While routing: which end the corner goes on (Altium's Space; Space pans here). While dragging: corner mode.",
    "Tab":"Properties of the active tool or the object being placed (routing width, via, component, net label, port); while length tuning, tuning properties.",",":"Smaller arc radius while routing; miter while tuning.",".":"Larger arc radius while routing; miter while tuning.",
    "Left":"Figma: arrows nudge the selection. While placing: step the cursor. Nothing selected: pan.","Shift+Left":"×10.","Space":"Figma: hold Space and move to pan, in every tool.",
    "Shift+F10":"Context menu (Windows convention).","ContextMenu":"Context menu key."
  };
  for(let n=2;n<=9;n++)MODERN_WHY["Mod+"+n]=n<9?"Tab "+n+", as ⌘1.":"The last tab (Safari, Chrome).";
  for(const d of ["Right","Up","Down"]){MODERN_WHY[d]="As ←.";MODERN_WHY["Shift+"+d]="×10.";}
  // Deliberately left off the Modern preset: [key, why].
  const MODERN_LEFT_OFF=[
    ["⌘H, ⌥⌘H","macOS: Hide Waffle, Hide Others."],["⌘M, ⌥⌘M","macOS: Minimize, Minimize All."],["⌘Q, ⇧⌘Q, ⌃⌘Q","Quit, Log Out, Lock Screen."],
    ["⌘⇥, ⌘`","App and window cycling."],["⌘Space, ⌃⌘Space, ⌥⌘Space","Spotlight, the emoji viewer, Finder search."],["⌃⌘F","Full screen (the native View menu)."],
    ["⌥⌘⎋, ⇧⌘⎋","Force Quit; Waffle's Pause All Extensions kill switch."],["⇧⌘3, ⇧⌘4, ⇧⌘5","Screenshots."],["⌥⌘D","Show or hide the Dock."],
    ["⌃←, ⌃→, ⌃↑, ⌃↓","Mission Control and Spaces. (So nothing uses ⌘ arrows either: on a PC they would be Ctrl arrows.)"],
    ["F-keys","Mac keyboards make them media keys; the Allegro-like preset is the function-key profile."],
    ["Two-key Altium sequences (P W, T D …)","The point of this preset; rare commands are ⌘K chords or the palette instead."],
    ["⌘1…⌘9 selection memory, J 1…9 saved views","⌘1…⌘9 are document tabs here. Selection memory and saved views stay on Window › Selection Memory and the palette."],
    ["⌘G Find Next","Waffle's find opens a list; there is no incremental find to repeat, so ⌘G groups as in Figma."],
    ["⇧⌘1 / ⇧1 zoom to fit (Figma)","Shift+digit types a different character on each layout; ⌘0 fits."],
    ["F2 rename","Return renames, as in Finder."],["Ctrl+W route, Ctrl+M measure, Ctrl+H select net","Altium-isms on Control; R, M and the palette replace them."]
  ];
  // macOS chords Modern (Mac) must never bind (tests/keymap.cjs checks every key of every binding, chords included).
  const MAC_RESERVED=["Meta+H","Alt+Meta+H","Meta+M","Alt+Meta+M","Meta+Q","Shift+Meta+Q","Ctrl+Meta+Q","Meta+Tab","Shift+Meta+Tab","Meta+Space","Ctrl+Meta+Space","Alt+Meta+Space",
    "Ctrl+Meta+F","Alt+Meta+Escape","Shift+Meta+Escape","Meta+`","Shift+Meta+`","Shift+Meta+3","Shift+Meta+4","Shift+Meta+5","Alt+Meta+D",
    "Ctrl+Left","Ctrl+Right","Ctrl+Up","Ctrl+Down","F11"];

  // The Modern palette takes focus immediately. Continue its actual key sequence in the input.
  function continuation(lead,start,state,canvas,hint){
    let table=K.table(),pending=start;
    const atPath=(root,node)=>node.path.reduce((at,chord)=>at?.children?.get(chord),root);
    return (event,dispatch)=>{
      if(!pending||event.defaultPrevented||event.isComposing)return false;
      const latest=K.table();
      if(latest!==table){
        if(K.leadOf(atPath(latest.rootNode,start),state,canvas)?.id!==lead.id){pending=null;return false;}
        pending=atPath(latest.rootNode,pending);table=latest;
        if(!pending)return false;
      }
      const key=K.eventKey(event);
      if(key===K.MODIFIER)return false;
      const child=key>=0&&pending.children?.get(key*16+K.eventMask(event,key));
      if(!child||!K.live(child,state,canvas)){pending=null;return false;}
      event.preventDefault();
      if(event.repeat)return true;
      if(K.isPrefix(child,state,canvas)){pending=child;hint(K.hintText(child,state,canvas));return true;}
      pending=null;hint("");dispatch(K.firstPass(child.bindings,state,canvas));return true;
    };
  }
  return {classic:CLASSIC,vscodeDecisions:VSCODE_DECISIONS,allegro:ALLEGRO,allegroDecisions:ALLEGRO_DECISIONS,modern:MODERN,modernModules:MODERN_MODULES,newCommands:NEW_COMMANDS,modernWhy:MODERN_WHY,modernLeftOff:MODERN_LEFT_OFF,macReserved:MAC_RESERVED,continuation};
})();
