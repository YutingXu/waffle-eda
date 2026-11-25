#!/usr/bin/env python3
"""Reachability matrix: where every user-facing action can be reached from.

Surfaces, per editor (schematic, board):
  menu      the menu bar, with its path (Tools › Polygon Pours › Repour All)
  palette   the command palette (Ctrl/Cmd+Shift+P), with its title
  shortcut  a keyboard shortcut (the keymap's default Altium preset)
  context   the right-click context menu for canvas objects, the project or a document
  panel     the status-bar Panels menu or Window › Panels

The action list is the headless inventory (scripts/headless-inventory.py: menus, keymap, registerAction,
the editor's act switch). Surfaces are read at runtime in headless Chrome, where menus that modules add
on load, lazy command stubs and the palette's own entry list are all live. Use --static to read the
menus, keymap and context table statically. That scan misses runtime additions.

Usage:
  scripts/reachability.py               write docs/reachability.md using Chrome (set CHROME if needed)
  scripts/reachability.py --static      static scan only
  scripts/reachability.py --json        print the matrix as JSON
  scripts/reachability.py --check       exit 1 on a hard problem: a menu or palette title with "..." instead
                                        of "…", a duplicate label in one menu, a toggle without a check mark,
                                        a user action reachable only from the palette, or an action on a menu that
                                        has an Altium default key (ALTIUM_KEYS) but no shortcut ("Altium key missing" > 0),
                                        or a "…" label (menu bar, context menu, Active Bar, palette) whose action opens no
                                        dialog (runtime scan: each such action is run once and watched for a <dialog>, a file
                                        picker, a save panel or the print dialog; STATEFUL lists actions that open theirs only
                                        once something is selected or copied)
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
DOC = ROOT / "docs" / "reachability.md"
sys.path.insert(0, str(ROOT / "scripts"))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("headless_inventory", ROOT / "scripts" / "headless-inventory.py")
INV = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(INV)

KINDS = ("schematic", "pcb")
SURFACES = ("menu", "palette", "shortcut", "context", "panel", "toolbar")
# Commands whose buttons live on the Preferences page (a panel), not on a menu.
PAGE = {"export-settings", "import-settings", "import-vscode-theme", "import-vscode-keybindings", "preferences-page"}

# Actions that are keys inside a live session, pointer gestures or internal plumbing: they are not
# meant to be on a menu, and the palette hides them.
SESSION = re.compile(r"^(route-(arc|autoshrink|back|bend|conflict|layer-next|layer-prev|mode|transition|via|via-size|width)|length-(amplitude|gap|miter|rounding|properties|key)"
                     r"|route-suggest-(accept|next|prev|word|dismiss)$|cursor-|camera-pan-|nudge|zoom-at|zoom-(in|out)-pointer|pan-hold|keep-routing|prefix-cancel|escape|place-at-pointer|select-at-pointer|tool-properties|select$|deselect$"
                     r"|rotate-c|move-object|move-corner-mode|move-properties|swap-components-origin|swap-variant-back|close-dialog|view3d-|grid-(next|prev)$|context-menu$)")
# Toggles: their menu item must show a check mark (data-checkable or role=menuitemcheckbox).
TOGGLES = {"grid", "smart-guides", "sch-hop-overs", "hud", "snap-object", "drc-markers", "timing-vision", "timing-vision-live", "drc-online", "cross-select",
           "dfa-live", "pour-live", "z-clearance-overlay", "rooms-show", "net-colours", "unrouted", "drag-reroute-toggle", "designators-follow",
           "sch-auto-increment", "messages", "toggle-left", "toggle-right", "nets-panel", "pcb-list", "scripting-console", "library-panel", "query-panel",
           "navigator-panel", "calculators"}
# Altium default shortcuts for actions that have one in Altium (PCB and schematic editors).
# Ctrl+P (Print in Altium) is Quick open since 2026-11-23 (user decision); Print stays on File › Print….
ALTIUM_KEYS = {"drc": "T D", "rules": "D R", "stackup": "D K", "eco": "D U", "component-classes": "D C", "annotate": "T A A", "cross-probe": "T C",
               "repour": "T G A", "pour-manager": "T G M", "teardrops": "T E", "length-tune": "T R", "find-similar": "Shift+F", "view-config": "L",
               "toggle-units": "Q", "measure": "Ctrl+M", "route": "P T / P W", "via": "P V", "polygon-pour": "P G", "library": "P C / P P",
               "autoroute-all": "A A", "fanout": "A F", "flip-board": "V B", "view-3d": "3", "view-2d": "2", "fit-document": "V D", "fit-objects": "V F",
               "compile": "C C", "select-all": "Ctrl+A", "keyboard-shortcuts": "", "preferences": "T P / O P", "board-edit-vertices": "D S E",
               "room-move": "D M M", "length-tune-pair": "T I", "route-diffpair": "P I", "swap-components": "T W S", "unrouted": "N",
               "shortcuts": "Shift+F1", "find-replace": "Ctrl+H", "rubber-stamp": "Ctrl+R", "duplicate": "Ctrl+D", "save": "Ctrl+S", "open": "Ctrl+O",
               "undo": "Ctrl+Z", "redo": "Ctrl+Y", "copy": "Ctrl+C", "cut": "Ctrl+X", "paste": "Ctrl+V", "delete": "Del",
               "grid-custom": "Ctrl+G", "layer-mode": "Shift+S", "hud": "Shift+H", "snap-object": "Shift+E", "net-colours": "F5",
               "select-net": "S N", "highlight-net": "Ctrl+click", "length": "", "messages": "",
               # Altium chord pass
               "measure-primitives": "R P", "measure-selected": "R S", "bom": "R B", "delete-pick": "E D", "select-inside": "S I", "select-outside": "S O",
               "lasso-select": "S L", "move-selection": "M S", "drag-object": "M D", "move-object": "M M", "autoroute-net": "U A N", "autoroute-connection": "U A C",
               "autoroute-component": "U A O", "autoroute-area": "U A R", "unroute-all": "U U A", "delete-net-copper": "U U N", "unroute-connection": "U U C",
               "unroute-component": "U U O", "unroute-room": "U U R", "align-left": "A L", "align-right": "A R", "align-top": "A T",
               "align-bottom": "A B", "align-hcenter": "A C", "align-vcenter": "A V", "distribute-h": "A D", "distribute-v": "A I", "align-grid": "A G",
               "layer-next": "+", "layer-prev": "-", "layer-signal-next": "*",
               # Altium chords part 2 (app/schematic/altium-tools.js)
               "select-touching": "S T", "select-connection": "S C", "select-physical": "S P", "align-dialog": "E G A", "autoroute-room": "U A M"}
# "…" means a dialog follows (a <dialog>, a file picker, a save panel or the print dialog). These
# actions open theirs only with a selection, a clipboard, a marker or a room, which the runtime scan
# (a project with nothing selected or copied) does not have; each was checked by hand.
STATEFUL = {
    "find-similar": "Find Similar Objects dialog, for the selected object",
    "align-dialog": "Align Objects dialog, with two or more objects selected", "autoroute-room": "autorouter dialog, for a room with components",
    "make-row": "pitch prompt, with two or more objects selected", "make-column": "pitch prompt, with two or more objects selected",
    "paste-array": "Paste Array dialog, with something copied", "paste-special": "Paste Special dialog, with something copied",
    "swap-library": "library picker, for the selected component", "swap-variant-pick": "footprint picker, for the selected component",
    "edit-symbol": "symbol editor, for the selected part", "edit-footprint": "footprint editor, for the selected part",
    "dynamic-connector-pins": "pin count dialog, for the selected dynamic connector",
    "dynamic-connector-finalise": "Finalise dialog, for the selected dynamic connector",
    "dynamic-connector-add-part": "Add Part dialog, for the selected dynamic connector",
    "generic-bind": "Bind to Manufacturer Part dialog, for the selected generic part",
    "diffpair-retrace": "gap prompt, once a pair track is picked", "room-replicate": "Copy Room Formats dialog, when the board has rooms",
    "drc-waive": "waiver note dialog, on a DRC marker",
    "save-project-zip": "archive picker for a native project folder",
    "discard-import-data": "confirmation for retained imports in a native project folder",
    "git-commit": "Commit dialog for staged project members, exercised by tests/formats/browser-format-2-git.cjs",
}
# Context-menu entries that run their own function rather than the action (custom:true from
# AtriumContextMenu.labels); the label describes that function. Checked by hand.
CUSTOM_DIALOG = {"Pour Properties…": "the pour's properties dialog"}

SMALL = {"a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "with", "within", "per", "via"}

PROBE = r"""
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const menuHidden=b=>b.hidden||!!b.closest("[hidden]")||getComputedStyle(b).display==="none";
function pathOf(b){const parts=[];let n=b.parentElement;while(n){if(n.classList?.contains("submenu"))parts.unshift((n.querySelector(":scope > .submenu-trigger")?.dataset.label||n.querySelector(":scope > .submenu-trigger")?.textContent||"").trim());
  if(n.classList?.contains("work-menu")){parts.unshift(n.querySelector("summary")?.textContent.trim()||n.dataset.menu);break;}n=n.parentElement;}return parts;}
function menus(){const out=[];for(const b of document.querySelectorAll(".work-menu .menu-items [data-action]")){const m=b.closest(".work-menu");
  out.push({action:b.dataset.action,label:AtriumNavCommon.menuLabel(b),path:pathOf(b),bar:!!b.closest(".menubar"),menu:m.dataset.menu,
    scope:b.dataset.scope||"",hidden:menuHidden(b),check:!!(b.dataset.checkable||/checkbox|radio/.test(b.getAttribute("role")||"")||b.matches('[data-action=grid],[data-action^=toggle-]')),
    hint:b.dataset.hint||""});}return out;}
function topCounts(){const o={};for(const m of document.querySelectorAll(".menubar .work-menu")){const l=m.querySelector(".menu-items");if(!l)continue;
  o[m.dataset.menu]=[...l.children].filter(n=>n.tagName!=="HR"&&!menuHidden(n)).length;}return o;}
async function selectEditor(kind){
  const tab=document.querySelector('#document-tabs [data-tab][data-kind="'+kind+'"]');
  if(!tab)throw Error("The demo is missing its "+kind+" editor tab");
  tab.click();
  await wait(5);
  if(globalThis.AtriumNavHost.doc().kind!==kind)throw Error("Could not switch to the "+kind+" editor");
  return tab;
}
async function collect(kind){
  const tab=await selectEditor(kind);
  await wait(150);
  const KM=globalThis.AtriumKeymap,P=globalThis.AtriumPalette;
  const palette=(P?.entries?.(">")||[]).map(e=>({action:e.action||e.key,label:e.label,detail:e.detail||"",hint:e.hint||""}));
  const commands=KM?.commands?.()||[];
  const keys={};for(const c of commands){const h=KM.hintFor(c.id,kind);if(h)(keys[c.action]||(keys[c.action]=[])).push(h);}
  const bars=[...document.querySelectorAll(".statusbar [data-action],#tools [data-action],.view-palette [data-action],.layer-bar [data-action],.quick-access [data-action],.editor-tabbar [data-action],.appbar > button[data-action]")].filter(n=>!n.closest(".menu-items")&&!n.closest("[hidden]")).map(n=>n.dataset.action);
  bars.push(...commands.filter(c=>/^doc-tab-[1-9]$/.test(c.action)).map(c=>c.action));
  const contextMenu=globalThis.AtriumContextMenu;
  const ctx=contextMenu?.table?.(kind)||{};
  const ctxLabels=contextMenu?.labels?.(kind)||[];
  if(contextMenu?.explorer){
    const project=document.querySelector(".project-tree summary");
    if(!project)throw Error("The demo is missing its project explorer");
    for(const [type,target] of [["project",project],["document",tab]]){
      const menu=contextMenu.explorer(globalThis.AtriumNavHost,target,0,0);
      const buttons=[...menu.querySelectorAll("[data-menu-action]:not(:disabled)")];
      ctx[type]=[...new Set(buttons.map(b=>b.dataset.menuAction))];
      ctxLabels.push(...buttons.map(b=>({type,action:b.dataset.menuAction,label:b.firstElementChild.textContent})));
      contextMenu.close(false);
    }
  }
  const active=[];for(const g of Object.values(globalThis.AtriumActiveBarMenu?.GROUPS||{}))for(const [action,label,scope] of g)if(!scope||scope===kind)active.push({action,label});
  return {menus:menus(),top:topCounts(),palette,keys,bars,context:ctx,ctxLabels,active};
}
// "…" audit: run every action that has a "…" label once and record whether a dialog opened.
let opened=[];
const activeExports = new Set();
function instrument(){
  // Keep each save picker with the action that launched it, including first-use worker startup.
  // The real worker and its file writer run unchanged; only the host save panel is intercepted.
  const client = globalThis.AtriumTranslatorClient;
  if(client){
    const wrapped = {...client, export(...args){
      const task = client.export(...args);
      activeExports.add(task);
      const done = () => activeExports.delete(task);
      task.then(done,done);
      return task;
    }};
    globalThis.AtriumTranslatorClient = wrapped;
    if(globalThis.AtriumImport === client)globalThis.AtriumImport = wrapped;
  }

  const P=HTMLDialogElement.prototype,sm=P.showModal,sh=P.show;
  P.showModal=function(){opened.push("dialog");return sm.call(this);};P.show=function(){opened.push("dialog");return sh.call(this);};
  HTMLInputElement.prototype.click=function(){if(this.type==="file")opened.push("file picker");};
  window.print=()=>opened.push("print");
  const stub=(o,k,tag)=>{if(o&&typeof o[k]==="function")o[k]=()=>{opened.push(tag);return Promise.resolve(null);};};
  stub(globalThis.AtriumIO,"pickFile","file picker");stub(globalThis.AtriumIO,"exportFile","save panel");stub(globalThis.AtriumIO,"exportBinaryCopy","save panel");
  stub(globalThis.AtriumIO,"save","save panel");stub(globalThis.AtriumHost,"open","file picker");
}
// Floating panels with role=dialog (View Configuration) count as dialogs too.
const floating=()=>[...document.querySelectorAll('[role="dialog"]:not(dialog)')].filter(n=>!n.hidden&&n.isConnected&&n.getClientRects().length);
function settle(kind){
  for(const d of document.querySelectorAll("dialog[open]"))try{d.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));if(d.open)d.close();}catch{}
  for(const d of document.querySelectorAll("details[open]"))d.open=false;
  globalThis.AtriumContextMenu?.close?.(false);
  for(const n of floating())n.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  // An action that opened the 3D view (3D STEP…) would leave the next ones answering "Press 2".
  if(kind==="pcb")window.dispatchEvent(new CustomEvent("atrium-command",{detail:"view-2d"}));
  document.getElementById("canvas")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",code:"Escape",bubbles:true}));
}
async function prepareDialog(action){
  const host=globalThis.AtriumNavHost;
  if(action==="discard-import-data"){
    const reports=globalThis.AtriumImportReports, session=host.fileSession(), previous=reports.capture();
    const client=await AtriumLazy.need("AtriumTranslatorClient");
    const name="Reachability.kicad_sch", bytes=new TextEncoder().encode(
      '(kicad_sch (version 20231120) (generator eeschema) (paper "A4") (lib_symbols) (wire (pts (xy 10 10) (xy 20 10))))');
    const report=await client.import([{name,bytes}]);
    reports.remember(session,report,[host.currentId()],[name]);
    return ()=>reports.restore(session,previous);
  }
  if(["save-as","save-project-zip"].includes(action) && !host.folderProject?.() && !globalThis.AtriumHost?.chooseProjectFolder){
    // Observe the desktop picker without adopting a new project during the dialog audit.
    const previous=globalThis.AtriumHost;
    globalThis.AtriumHost={...previous,chooseProjectFolder:async()=>{opened.push("save panel");return null;}};
    return ()=>{if(previous)globalThis.AtriumHost=previous;else delete globalThis.AtriumHost;};
  }
  if(action==="save-project-zip" && !host.isDirty()){
    host.edit(()=>host.doc().notes.push("Unsaved archive fixture"),"Unsaved archive fixture");
    return ()=>host.act("undo");
  }
}
async function dialogs(kind,data){
  const labels=[...data.menus.filter(m=>m.bar&&!m.hidden),...data.palette,...data.ctxLabels,...data.active];
  const acts=[...new Set(labels.filter(l=>/…|\.\.\./.test(l.label)).map(l=>l.action))].filter(a=>!/^view-3d$|^view3d-/.test(a));
  const out={},cmds=globalThis.AtriumKeymap?.commands?.()||[];
  for(const a of acts){
    await selectEditor(kind);
    const cleanup=await prepareDialog(a);opened=[];
    const before=new Set(floating());
    const n=document.querySelector('.menubar [data-action="'+a+'"]'),cmd=cmds.find(c=>c.action===a&&c.run);
    try{if(n&&!n.disabled&&!menuHidden(n))n.click();else if(cmd)cmd.run(cmd.param);else window.dispatchEvent(new CustomEvent("atrium-command",{detail:a}));}catch{}
    for(let i=0;i<100&&/^Loading/.test(document.getElementById("status")?.textContent||"");i++)await wait(10);
    await wait(60);
    while(activeExports.size)await Promise.allSettled([...activeExports]);
    await wait(0);
    if(document.querySelector("dialog[open]")||floating().some(n=>!before.has(n)))opened.push("dialog");
    out[a]={opened:[...new Set(opened)],status:(document.getElementById("status")?.textContent||"").slice(0,120)};
    settle(kind);cleanup?.();await wait(10);
  }
  return out;
}
async function probe(){
  const host=globalThis.AtriumNavHost;
  // The isolated profile has nothing to recover.
  if(!host||!await host.replaceProject(globalThis.AtriumParts.example(),{force:true,copy:true,dirty:false})){
    throw Error("Could not load the Sensor interface demo");
  }
  globalThis.AtriumStartPage?.close();
  const L=globalThis.AtriumLazy;
  // Load every lazy module so the menu items they add on load are present.
  const skip=new Set(["AtriumExtensions"]);
  for(const n of L?.modules?.()||[]){if(skip.has(n))continue;try{await L.need(n);}catch{}}
  await wait(300);for(const d of document.querySelectorAll("dialog[open]"))try{d.close();}catch{}
  if(L?.has?.("AtriumContextMenu")===false)try{await L.need("AtriumContextMenu");}catch{}
  const out={};for(const k of ["schematic","pcb"])out[k]=await collect(k);
  instrument();for(const k of ["schematic","pcb"])out[k].dialogs=await dialogs(k,out[k]);
  return out;
}
"""


def chrome():
    for c in (os.environ.get("CHROME"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
              "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"):
        if c and os.access(c, os.X_OK):
            return c
    return None


def runtime():
    exe = chrome()
    if not exe:
        raise RuntimeError("Chrome or Chromium is required for a runtime scan. Set CHROME to its executable or pass --static.")
    page = (APP / "index.html").read_text(encoding="utf-8")
    pre = '<base href="%s/"><script>globalThis.ATRIUM_ENGINE="js";</script>' % APP.as_uri()
    page = page.replace("<head>", "<head>" + pre, 1).replace("</body>", "<script>" + PROBE + "</script></body>", 1)

    # Desktop translation uses real workers. Chrome's dump-dom virtual clock can finish
    # while one is starting. Await the page's result through the existing DevTools harness.
    spec = importlib.util.spec_from_file_location("worker_start", ROOT / "tests" / "workers" / "worker-start.py")
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    with tempfile.TemporaryDirectory(prefix="atrium-reach.") as directory:
        target = Path(directory) / "page.html"
        target.write_text(page, encoding="utf-8")
        tab = harness.Page(exe, target.as_uri(), directory)
        try:
            tab.call("Emulation.setDeviceMetricsOverride", width=1440, height=900, deviceScaleFactor=1, mobile=False)
            for _ in range(300):
                if tab.eval("typeof probe === 'function' && !!globalThis.AtriumNavHost && !!globalThis.AtriumLazy"):
                    return tab.eval("probe()")
                time.sleep(.1)
            raise RuntimeError("Chrome did not load the reachability fixture.")
        finally:
            tab.close()


# ------------------------------------------------------------------ static fallback
def static(fixture=None):
    rows = INV.inventory(fixture=fixture)
    text = (APP / "index.html").read_text(encoding="utf-8")
    menus = []
    for r in rows:
        for m in r["menus"]:
            if m != "toolbar":
                menus.append({"action": r["action"], "label": (r["labels"] or [r["action"]])[0], "path": [m.capitalize()], "bar": m != "panels", "menu": m,
                              "scope": "", "hidden": False, "check": False, "hint": ""})
    keys = {}
    # Default bindings from AtriumKeymap.bindingsFor. The keymap applies preset drops.
    for row in INV.keymap_commands(fixture):
        if row.get("registration") == "extension":
            continue
        for binding in row["bindings"]:
            keys.setdefault(row["action"], [])
            if binding["key"] not in keys[row["action"]]:
                keys[row["action"]].append(binding["key"])
    ctx = {}
    cm = APP / "editor/context-menu.js"
    if cm.is_file():
        src = cm.read_text(encoding="utf-8")
        for m in re.finditer(r'^\s{4}(\w+):\s*\[(.*?)^\s{4}\]', src, re.S | re.M):
            ctx[m.group(1)] = [a for _, a in re.findall(r'\["([^"]+)",\s*"([\w:-]+)"', m.group(2))]
    one = {"menus": menus, "top": {}, "palette": [{"action": r["action"], "label": (r["labels"] or [r["action"]])[0], "detail": "", "hint": ""} for r in rows
                                                   if r["menus"] or any(s.startswith(("editor/keymap.js", "lazy.js")) or "registerCommand" in s for s in r["sources"])],
           "keys": keys, "bars": [], "context": ctx or None}
    return {k: one for k in KINDS}


# ------------------------------------------------------------------ analysis
def title_case_problem(label):
    text = re.sub(r"\(.*?\)|“.*?”|\".*?\"", "", label).replace("…", "").strip()
    words = re.findall(r"[A-Za-z][\w'’-]*", text)
    for i, w in enumerate(words):
        if w.lower() in SMALL and i:
            continue
        if re.fullmatch(r"(mm|mil|mils|vs|x2|ps|db)", w):
            continue
        if w[0].islower():
            return "not Title Case (“%s”)" % w
    return ""


def analyse(data, actions):
    rows = {}
    for a in actions:
        rows[a["action"]] = {"action": a["action"], "label": (a["labels"] or [""])[0], "kinds": {}, "issues": []}
    issues = []
    for kind in KINDS:
        d = data[kind]
        ctx = d.get("context") or {}
        ctx_types = {}
        for t, acts in ctx.items():
            for x in acts:
                ctx_types.setdefault(x, []).append(t)
        pal = {}
        for e in d["palette"]:
            pal.setdefault(e["action"], e)
        panel_actions = {m["action"] for m in d["menus"] if m["menu"] == "panels" or (m["path"][1:2] == ["Panels"])}
        bar = {}
        for m in d["menus"]:
            if m["bar"] and not m["hidden"]:
                bar.setdefault(m["action"], []).append(m)
        every = set(rows) | set(bar) | set(pal) | set(ctx_types)
        for a in every:
            r = rows.setdefault(a, {"action": a, "label": "", "kinds": {}, "issues": []})
            ms = bar.get(a, [])
            k = {"menu": " › ".join(ms[0]["path"] + [ms[0]["label"]]) if ms else "",
                 "palette": pal[a]["label"] if a in pal else "", "shortcut": ", ".join(dict.fromkeys(d["keys"].get(a, []))),
                 "context": ", ".join(ctx_types.get(a, [])), "panel": "Preferences page" if a in PAGE else "yes" if a in panel_actions else "",
                 "toolbar": "yes" if a in set(d.get("bars") or []) else ""}
            r["kinds"][kind] = k
            if ms and not r["label"]:
                r["label"] = ms[0]["label"]
            if a in pal and not r["label"]:
                r["label"] = pal[a]["label"]
            if len(ms) > 1 and len({" › ".join(m["path"]) for m in ms}) == len(ms):
                pass  # one action under two menus is fine (Window › Panels mirrors the status-bar menu)
            for m in ms:
                if "..." in m["label"]:
                    r["issues"].append("“...” instead of “…”")
                p = title_case_problem(m["label"])
                if p:
                    r["issues"].append(kind + " menu label " + p)
                if a in TOGGLES and not m["check"]:
                    r["issues"].append("toggle without a check mark")
            if a in pal and "..." in pal[a]["label"]:
                r["issues"].append("palette title has “...”")
            if a in pal and not any(k[x] for x in ("menu", "shortcut", "context", "panel", "toolbar")) and not SESSION.search(a) and "." not in a and not a.startswith(("theme-", "library:", "rooms:", "multichannel:", "power:", "doc-tab-")):
                r["issues"].append(kind + ": palette only")
        # "…" only where a dialog opens (runtime scans only: the static scan cannot run actions).
        if d.get("dialogs") is not None:
            shown = [("menu", m["action"], m["label"]) for m in d["menus"] if m["bar"] and not m["hidden"]]
            shown += [("palette", e["action"], e["label"]) for e in d["palette"]]
            shown += [("context menu", e["action"], e["label"]) for e in d.get("ctxLabels") or [] if not (e.get("custom") and e["label"] in CUSTOM_DIALOG)]
            shown += [("Active Bar", e["action"], e["label"]) for e in d.get("active") or []]
            for surface, a, label in shown:
                if "…" not in label or a in STATEFUL or "." in a:
                    continue
                probe = d["dialogs"].get(a)
                if probe is not None and not probe["opened"]:
                    rows.setdefault(a, {"action": a, "label": "", "kinds": {}, "issues": []})["issues"].append(
                        "%s: “…” but no dialog opens (%s “%s”)" % (kind, surface, label))
        # Duplicate labels in one visible menu (different actions, same text).
        seen = {}
        for m in d["menus"]:
            if not m["bar"] or m["hidden"]:
                continue
            key = (" › ".join(m["path"]), m["label"].lower())
            if key in seen and seen[key] != m["action"]:
                issues.append("%s: duplicate label “%s” in %s (%s, %s)" % (kind, m["label"], key[0], seen[key], m["action"]))
            seen[key] = m["action"]
        for menu, n in (d.get("top") or {}).items():
            if n > 24:
                issues.append("%s: %s menu has %d top-level items (group them into submenus)" % (kind, menu, n))
    for r in rows.values():
        r["issues"] = list(dict.fromkeys(r["issues"]))
        # Extension commands (ids with a dot) depend on which extensions are installed and started.
        r["user"] = not SESSION.search(r["action"]) and "." not in r["action"]
    return rows, issues


def counts(rows):
    out = {}
    for kind in KINDS:
        user = [r for r in rows.values() if r["user"] and kind in r["kinds"] and any(r["kinds"][kind].values())]
        out[kind] = {"actions": len(user), **{s: sum(1 for r in user if r["kinds"][kind][s]) for s in SURFACES},
                     "palette only": sum(1 for r in user if r["kinds"][kind]["palette"] and not any(r["kinds"][kind][s] for s in ("menu", "shortcut", "context", "panel", "toolbar")) and "." not in r["action"] and not r["action"].startswith("power:")),
                     "Altium key missing": sum(1 for r in user if ALTIUM_KEYS.get(r["action"]) and not r["kinds"][kind]["shortcut"] and r["kinds"][kind]["menu"])}
    return out


def markdown(rows, issues, mode):
    c = counts(rows)
    out = ["# Reachability", "",
           "Generated by `scripts/reachability.py` (%s scan). Do not edit by hand. For every user-facing action it lists where the action can be reached from: "
           "the menu bar (with its path), the command palette (with its title), a keyboard shortcut (default Altium preset), the right-click context menus "
           "(canvas objects, project and document), the panels (status-bar Panels menu, Window › Panels, the Preferences page) and the toolbars (Active Bar, status bar, quick access, editor tabs)." % mode, "",
           "| Editor | Actions | Menu | Palette | Shortcut | Context | Panel | Toolbar | Palette only | Altium key missing |",
           "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for kind in KINDS:
        k = c[kind]
        out.append("| %s | %d | %d | %d | %d | %d | %d | %d | %d | %d |" % ("Schematic" if kind == "schematic" else "Board", k["actions"], k["menu"], k["palette"],
                                                                      k["shortcut"], k["context"], k["panel"], k["toolbar"], k["palette only"], k["Altium key missing"]))
    out += ["", "Session keys (routing and tuning keys, cursor steps, Escape) are excluded: they act inside a live tool, not as commands.", ""]
    out += ["## Problems", ""]
    probs = issues + ["`%s`: %s" % (r["action"], "; ".join(r["issues"])) for r in sorted(rows.values(), key=lambda r: r["action"]) if r["issues"] and r["user"]]
    out += ["- " + p for p in probs] if probs else ["None."]
    missing = sorted(a for a, r in rows.items() if r["user"] and ALTIUM_KEYS.get(a) and any(k["menu"] and not k["shortcut"] for k in r["kinds"].values()))
    if missing:
        out += ["", "Altium has a default shortcut, Waffle has none: " + ", ".join("`%s` (%s)" % (a, ALTIUM_KEYS[a]) for a in missing) + "."]
    out += ["", "## Matrix", "", "Each cell shows the schematic editor first, then the board (`sch / pcb`) when they differ.", "",
            "| Action | Menu | Palette title | Shortcut | Context | Panel | Toolbar |", "| --- | --- | --- | --- | --- | --- | --- |"]
    esc = lambda s: s.replace("|", "\\|")  # noqa: E731
    for a in sorted(rows):
        r = rows[a]
        if not r["user"] or not r["kinds"] or not any(any(v.values()) for v in r["kinds"].values()):
            continue
        cells = []
        for s in SURFACES:
            v = [r["kinds"].get(k, {}).get(s, "") for k in KINDS]
            cells.append(esc(v[0] if v[0] == v[1] else "%s / %s" % (v[0] or "—", v[1] or "—")) or "—")
        out.append("| `%s` | %s |" % (a, " | ".join(cells)))
    out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--static", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true")
    o = ap.parse_args()
    mode = "static" if o.static else "runtime"
    try:
        data = static() if o.static else runtime()
    except (OSError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print("Reachability scan failed. " + str(exc), file=sys.stderr)
        return 2
    rows, issues = analyse(data, INV.inventory())
    if o.json:
        print(json.dumps({"counts": counts(rows), "issues": issues, "rows": rows}, indent=1, sort_keys=True))
        return 0
    hard = [p for p in issues if "duplicate" in p] + ["%s: %s" % (r["action"], i) for r in rows.values() if r["user"] for i in r["issues"]
                                                       if "“...”" in i or "“…”" in i or "toggle" in i or "palette only" in i]
    c = counts(rows)
    for kind in KINDS:
        if c[kind]["Altium key missing"]:
            gone = sorted(a for a, r in rows.items() if r["user"] and ALTIUM_KEYS.get(a) and kind in r["kinds"] and r["kinds"][kind]["menu"] and not r["kinds"][kind]["shortcut"])
            hard.append("%s: Altium key missing for %s" % (kind, ", ".join("%s (%s)" % (a, ALTIUM_KEYS[a]) for a in gone)))
    if o.check:
        for p in hard:
            print(p)
        print(json.dumps(counts(rows)))
        return 1 if hard else 0
    DOC.write_text(markdown(rows, issues, mode), encoding="utf-8")
    print(mode, json.dumps(counts(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
