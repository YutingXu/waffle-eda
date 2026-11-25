#!/bin/zsh
# Click-through safety net for menus and lazily loaded modules (headless Chrome).
# Opens app/index.html in a fresh profile, switches to a schematic or a board, then triggers every
# [data-action] once and checks that it raises no error and visibly does something: a dialog, a tool,
# a status message, a toggled control, a document change or a download request.
#
# Two passes per editor:
#   warm  every action in one session, in menu order (catches errors from state left by earlier actions)
#   cold  every action in its own fresh page (an iframe with cleared storage), so each action runs its
#         module's first load with nothing loaded before it. An action that only works after another
#         action has loaded its module fails here (round-3 bug 4: Update Schematics from PCB).
# An action fails when it throws, logs console.error, rejects a promise, leaves "Loading…" behind, or
# shows a "missing feature" message ("unavailable in this build", "Couldn't load …", "did not load", …)
# at any point while it runs: in the status bar (every intermediate text, not only the last one) or
# anywhere new in the page text (dialogs, panels, the Messages dock).
#
# Usage: scripts/click-through.sh [schematic|pcb ...] [--via click|command] [--warm|--cold] [--json]
#   --via click    real clicks on the menu items (default)
#   --via command  the "atrium-command" event used by the command palette and extensions
#   --warm/--cold  run only that pass (default: both)
# Env: CHROME=/path/to/chrome   VTB=virtual-time budget in ms for the warm pass (default 120000)
#      COLD_VTB=virtual-time budget for the cold pass (default 1200000)
#      CLICK_WALL_TIMEOUT=real seconds per Chromium launch (default 300).
#      APP=/path/to/app (default: this checkout's app/), e.g. to compare against an eager build
#      RENDERER=gpu|2d|auto  Preferences › Display › Renderer for every page (default: the app's own default).
#                            gpu runs Chrome with its GPU (no --disable-gpu) and reports the renderer in use.
# Exit status: 0 when every action passes, 1 otherwise.
root=${0:A:h:h}
via=click; json=0; kinds=(); passes=(warm cold)
while (( $# )); do case $1 in
  --via) via=$2; shift;; --json) json=1;; --warm) passes=(warm);; --cold) passes=(cold);; schematic|pcb) kinds+=$1;; *) print -u2 "unknown argument $1"; exit 2;;
esac; shift; done
(( $#kinds )) || kinds=(schematic pcb)
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-} ${commands[chromium-browser]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
[[ -x $chrome ]] || { print -u2 "Chrome or Chromium not found; set CHROME=/path/to/chrome"; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-click.XXXXXX"); trap 'rm -rf $tmp' EXIT
fail=0
gpuflag=--disable-gpu; [[ ${RENDERER:-} == gpu ]] && gpuflag=--ignore-gpu-blocklist
wall=${CLICK_WALL_TIMEOUT:-300}
cold_real=(save save-all save-as save-project-zip export-netlist-kicad export-netlist-protel export-netlist-csv export-idx-baseline export-idf
  messages navigator-panel library-panel find-similar start-page)
capture() {
  local label=$1 output=$2
  shift 2
  local trace="$output.chrome.log" began=$SECONDS
  timeout -k 5 "$wall" "$@" > "$output" 2> "$trace"
  local rc=$?
  if (( rc != 0 )); then
    if (( rc == 124 || rc == 137 )); then
      print -u2 -- "$label reached the ${wall}s Chromium wall-clock deadline"
    else
      print -u2 -- "$label Chromium exited $rc"
    fi
    print -u2 -- "Elapsed $((SECONDS - began))s"
    [[ -s $trace ]] && tail -n 12 "$trace" >&2
  fi
  return "$rc"
}
dump_chrome() {
  local label=$1 output=$2
  shift 2
  capture "$label" "$output" "$chrome" --enable-logging=stderr "$@"
}
for kind in $kinds; do
  python3 - "${APP:-$root/app}" "$tmp" "$kind" "$via" "${RENDERER:-}" <<'PY'
import sys,json
app,tmp,kind,via,renderer=sys.argv[1:6]
h=open(app+"/index.html").read()
# ONE: the cold pass loads this page once per action as page.html#one=<action>; storage is cleared
# before any app script runs so each load is a first launch.
pre='''<base href="file://%s/"><script>window.__errs=[];
window.ONE=location.hash.startsWith("#one=")?decodeURIComponent(location.hash.slice(5)):null;
if(ONE){try{localStorage.clear();sessionStorage.clear();}catch{}}
const RENDERER=%s;if(RENDERER){try{const k="atrium.prefs",o=JSON.parse(localStorage.getItem(k)||"null")||{format:"atrium-prefs",version:1,values:{}};o.values["display.renderer"]=RENDERER;localStorage.setItem(k,JSON.stringify(o));}catch{}}
addEventListener("error",e=>__errs.push("error: "+e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));
addEventListener("unhandledrejection",e=>__errs.push("rejection: "+(e.reason&&e.reason.message||e.reason)));
{const ce=console.error;console.error=(...a)=>{__errs.push("console.error: "+a.map(String).join(" "));ce.apply(console,a);};}
</script>'''%(app,json.dumps(renderer))
probe=r'''
const KIND=%s, VIA=%s;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Actions that legitimately change nothing in a fresh, unselected starter project.
const QUIET=new Set(["open","close-dialog","copy","cut","duplicate","delete","paste","rotate","redo","undo","fit","fit-objects","fit-document",
  "align-left","align-right","align-top","align-bottom","align-hcenter","align-vcenter","distribute-h","distribute-v","align-grid","make-row","make-column",
  "lock","unlock","union-create","union-break","union-add","flip-side","select-all","snap-options","save","zoom-in","zoom-out","theme-dark","split-close",
  "drc-clear"]); // drc-clear with no markers is a valid no-op
// A module that failed to load, or a feature reported missing, is a failure even with a status.
const MISSING=/unavailable in this build|Couldn.t load|did not load|is not loaded|not available in this build|support is not loaded|on the way/i;
// Board-only actions do nothing on a schematic, and schematic-only ones nothing on a board.
const QUIET_KIND={schematic:new Set(["find-similar","view-config","view-planning","view-3d","layer-mode","flip-board","via","pour-live","dfa-live","z-clearance-overlay","arrange-board","arrange-rect"]),pcb:new Set(["split-wire","junction"])};
const EXPORTS = {
  "save-project-zip": [".zip"],
  "export-netlist-kicad": [".net"],
  "export-netlist-protel": ["-protel.net"],
  "export-netlist-csv": [".csv"],
  "export-idx-baseline": ["-baseline.idx"],
  "export-idf": [".emn", ".emp"]
};
// A fresh browser Save creates a temporary folder and then downloads its archive.
const COLD_SAVES = new Set(["save", "save-all", "save-as"]);
// The DOM dump can observe a non-empty download request, without writing into Downloads.
// Browser integration separately verifies real completed downloads and reads their contents.
const blobs=new Map(), downloadRequests=[], pickerRequests=[];
const createURL=URL.createObjectURL.bind(URL), revokeURL=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createURL(blob);if(blob instanceof Blob)blobs.set(url,blob.size);return url;};
URL.revokeObjectURL=url=>{blobs.delete(url);revokeURL(url);};
document.addEventListener("click",event=>{
  const link=event.target.closest?.("a[download]");
  if(!link || !blobs.has(link.href))return;
  downloadRequests.push({name:link.download,bytes:blobs.get(link.href)});
  event.preventDefault();
},true);
function exportOutcome(a,from,status,suffixes){
  const files=downloadRequests.slice(from);
  if(suffixes.every(suffix=>files.some(file=>file.bytes>0&&file.name.endsWith(suffix))))return "download requested";
  if(a==="save-project-zip" && document.querySelector('dialog[open]:is([aria-label="Save project first"],[aria-label="Use saved project"])'))
    return "awaiting a save decision";
  if(a.startsWith("export-netlist-") && /^There are no annotated components to list\./.test(status))return "no annotated components";
  if(["export-idf","export-idx-baseline"].includes(a) && status==="Define a closed board outline before exporting to MCAD.")
    return "needs board outline";
  return "";
}
// Every status text while an action runs, so a "missing" message later overwritten (or restored
// by the lazy gate) still counts.
const seen=[];
new MutationObserver(()=>{const t=document.getElementById("status")?.textContent;if(t&&t!=="·")seen.push(t);}).observe(document.getElementById("status"),{childList:true,characterData:true,subtree:true});
const missingCount=()=>((document.body.innerText||"").match(new RegExp(MISSING.source,"gi"))||[]).length;
function sig(){
  const st=document.getElementById("status")?.textContent||"";
  const state=[...document.querySelectorAll("[aria-pressed],[aria-expanded],[aria-checked]")].map(n=>(n.getAttribute("aria-pressed")||"")+(n.getAttribute("aria-expanded")||"")+(n.getAttribute("aria-checked")||"")).join("");
  const dialogs=[...document.querySelectorAll("dialog[open]")].length+":"+[...document.querySelectorAll("dialog")].length;
  return {st,state,dialogs,body:document.body.className+"|"+document.body.dataset.kind+"|"+document.title,theme:(document.documentElement.dataset.theme||"")+"|"+(document.documentElement.dataset.themeId||""),
    nodes:document.body.getElementsByTagName("*").length,zoom:document.getElementById("zoom-value")?.textContent,
    panels:[...document.querySelectorAll("[hidden]")].length};
}
function cleanup(){
  for(const d of document.querySelectorAll("dialog[open]")){try{d.close();}catch{}}
  for(const d of document.querySelectorAll("details[open]"))d.open=false;
  if(document.querySelector('[data-action="split-close"]')&&!document.querySelector('[data-action="split-close"]').disabled)window.dispatchEvent(new CustomEvent("atrium-command",{detail:"split-close"}));
  const c=document.getElementById("canvas");c.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",code:"Escape",bubbles:true}));
}
function toKind(){const t=[...document.querySelectorAll("#document-tabs [data-tab]")].find(t=>t.dataset.kind===KIND);t?.click();}
const actionList=()=>[...new Set([...document.querySelectorAll(".menu-items [data-action],.toolbar [data-action],[role=menuitem][data-action],header [data-action],#tools [data-action]")].map(n=>n.dataset.action))].filter(Boolean);
async function runOne(a,loadWait){
  toKind();await wait(5);
  const candidates=[...document.querySelectorAll('[data-action="'+a+'"]')].filter(node=>!node.closest("[data-extension]"));
  // The cold roster comes from the warm session. A nested menu may still contain
  // commands for another editor even though the active editor cannot offer them.
  const otherScope='[data-scope]:not([data-scope="'+KIND+'"])';
  const n=candidates.find(node=>!node.closest(otherScope));
  if(!n && candidates.length)return {a,skip:"out-of-scope"};
  const startPageVisible=()=>document.querySelector("dialog.sp-dialog[open]")?.getClientRects().length>0;
  const startPageWasOpen=a==="start-page"&&startPageVisible();
  const suffixes=EXPORTS[a] || (ONE&&COLD_SAVES.has(a)&&!globalThis.AtriumHost?.chooseProjectFolder ? [".zip"] : null);
  const before=JSON.stringify(sig()),errs=__errs.length,marks=missingCount(),from=downloadRequests.length,pickerStart=pickerRequests.length;
  document.getElementById("status").textContent="·";seen.length=0;
  const t0=performance.now();
  try{
    // A disabled menu item is not offered by the menus or the palette either.
    if(VIA==="command"){if(n?.disabled)return {a,skip:"disabled"};window.dispatchEvent(new CustomEvent("atrium-command",{detail:a}));}
    else{if(!n)return {a,skip:"absent"};if(n.disabled)return {a,skip:"disabled"};n.click();}
  }catch(e){__errs.push("throw: "+e.message);}
  // Lazy modules: wait until "Loading…" clears.
  let st=()=>document.getElementById("status").textContent;
  for(let i=0;i<loadWait&&/^Loading/.test(st());i++)await wait(10);
  if(suffixes){
    // Keep the cold frame alive until its save worker and archive request have completed.
    const exportBudget=ONE?20000:6000;
    for(let elapsed=0;elapsed<exportBudget&&!exportOutcome(a,from,st(),suffixes)&&__errs.length===errs;elapsed+=10)await wait(10);
  }
  if(a==="add-existing"){
    for(let i=0;i<loadWait&&pickerRequests.length===pickerStart&&__errs.length===errs;i++)await wait(10);
  }
  const panelId=ONE && ({messages:"messages","navigator-panel":"navigator","library-panel":"library"})[a];
  const panelOpen=()=>globalThis.AtriumDock?.panels().find(p=>p.id===panelId)?.open && !/^Loading/.test(st());
  if(panelId){
    for(let i=0;i<loadWait&&!panelOpen()&&__errs.length===errs;i++)await wait(10);
  }
  const insights=a==="insights-panel";
  const insightsInView=()=>{
    const list=document.querySelector(".msg-panel .msg-grid");
    const docId=globalThis.AtriumNavHost?.doc()?.id;
    return list?.getClientRects().length && list===document.activeElement &&
      document.querySelector('#msg-tab-problems[aria-selected="true"]') &&
      globalThis.AtriumMessages?.messages().some(m=>m.group==="Insights"&&m.documentId===docId&&m.insightSummary);
  };
  if(insights){
    // The Messages dock may already be open and render the same number of rows.
    for(let i=0;i<loadWait&&!insightsInView()&&__errs.length===errs;i++)await wait(10);
  }
  const similar=a==="find-similar"&&KIND==="pcb";
  const similarReady=()=>/^Select an object, then Find Similar Objects/.test(st())||document.querySelector(".pcb-edit-similar[open]");
  if(similar){
    // The selection inspector-demand path does not write "Loading…" to the status.
    for(let i=0;i<loadWait&&!similarReady()&&__errs.length===errs;i++)await wait(10);
  }
  if(a==="start-page"&&!startPageWasOpen){
    // Help > Start Page opens through Preferences without setting a loading status.
    for(let i=0;i<loadWait&&!startPageVisible()&&__errs.length===errs;i++)await wait(10);
  }
  await wait(30);
  const after=sig();
  const s=st();after.st=s==="·"?JSON.parse(before).st:s;
  const changed=s!=="·"||JSON.stringify(after)!==before;
  const picks=pickerRequests.slice(pickerStart), picker=picks[0];
  const outcome=a==="add-existing" ? (picks.length===1 && picker.multiple &&
    [".wpcb",".wsch",".kicad_pcb"].every(ext=>picker.accept.includes(ext)) &&
    ![".waffle",".prjpcb",".kicad_pro"].some(ext=>picker.accept.includes(ext)) ? "document chooser requested" : "") :
    panelId ? (panelOpen() ? "panel opened" : "") :
    insights ? (insightsInView() ? "Design Insights shown in the focused Messages dock" : "") :
    similar ? (similarReady() ? "selection hint or matching dialog shown" : "") :
    a==="start-page" ? (!startPageWasOpen && startPageVisible() ? "Start Page opened" : "") :
    suffixes?exportOutcome(a,from,s,suffixes):null;
  const e=__errs.slice(errs);
  const missing=seen.filter(t=>MISSING.test(t));if(missingCount()>marks)missing.push("page text: "+((document.body.innerText||"").match(MISSING)||[""])[0]);
  if(/^Loading/.test(s))e.push("still loading");
  return {a,ok:!e.length&&!missing.length&&(outcome===null?(changed||QUIET.has(a)||QUIET_KIND[KIND].has(a)):!!outcome),changed,status:s==="·"?"":s.slice(0,90),
    ...(outcome===null?{}:{outcome,downloadRequests:downloadRequests.slice(from)}),
    missing:missing.map(t=>t.slice(0,90)),ms:Math.round(performance.now()-t0),errors:e};
}
async function runAction(a,loadWait){
  if(a!=="insert-palette")return runOne(a,loadWait);
  const labs=globalThis.AtriumLabs,pref="labs.notebook";
  const prefs=await AtriumLazy.need("AtriumPrefs"),before=prefs.get(pref);
  const changed=Object.hasOwn(prefs.changed(),pref);
  const button=document.querySelector('[data-action="insert-palette"]');
  const palette=()=>document.getElementById("palette");
  const fail=(result,error)=>({...result,ok:false,skip:undefined,errors:[...(result.errors||[]),error]});
  const optional=()=>JSON.stringify({
    scripts:[...document.scripts].map(script=>script.src).filter(src=>/\/(?:palette-(?:view|actions|personal)|extension-palette(?:-view)?|sheet-widgets?|calculation-intent)\.js$/.test(src)),
    workers:globalThis.AtriumExtensions?.workers.length||0,
    calculations:globalThis.AtriumCalculations?.stats?.().jobs||0
  });
  try{
    if(labs.preview){
      prefs.set(pref,false);
      const hidden=button && getComputedStyle(button).display==="none",work=optional();
      const off=await runOne(a,loadWait);
      if(!hidden||palette()?.open||off.errors?.length||off.missing?.length||optional()!==work)
        return fail(off,"Labs off must hide Insert or Search and leave the palette and optional work idle");
      prefs.set(pref,true);
    }
    const menu=button?.closest("details.work-menu");
    if(menu)menu.open=true;
    const available=button && !button.disabled && button.getClientRects().length>0;
    const on=await runOne(a,loadWait);
    const dialog=palette(),input=dialog?.querySelector("[role=combobox]");
    if(!available||!dialog?.open||dialog.dataset.mode!=="insert"||document.activeElement!==input)
      return fail(on,"Insert or Search must be available and focus the open insert palette");
    return {...on,profiles:labs.preview?["off","on"]:["on"]};
  }finally{
    if(labs.preview){if(changed)prefs.set(pref,before);else prefs.reset([pref]);}
  }
}
async function probe(){
  await wait(300);
  // Observe the real input request without raising the system dialog.
  HTMLInputElement.prototype.click=function(){
    if(this.type==="file")pickerRequests.push({multiple:this.multiple,accept:this.accept.toLowerCase().split(",")});
  };window.print=()=>{};
  const welcome=document.querySelector("dialog.sp-dialog[open]");
  if(welcome){
    welcome.querySelector('[data-start-action="close"]').click();
    for(let i=0;i<500&&welcome.open;i++)await wait(10);
    if(welcome.open)throw Error("Welcome did not finish opening the editor");
  }
  toKind();await wait(50);
  if(ONE){cleanup();await wait(50);const r=await runAction(ONE,500);parent.postMessage({one:r},"*");return {one:r};}
  const out=[];
  for(const a of actionList()){out.push(await runAction(a,200));cleanup();await wait(10);}
  return {kind:KIND,via:VIA,pass:"warm",count:out.length,actions:actionList(),loaded:Object.keys(globalThis).filter(k=>/^Atrium/.test(k)).length,results:out,
    renderer:globalThis.AtriumCanvasGPUPref?.describe?.()||"2D (canvas-gpu-pref.js not loaded)"};
}
'''%(json.dumps(kind),json.dumps(via))
h=h.replace("<head>","<head>"+pre,1)
h=h.replace("</body>","<script>%s\nsetTimeout(async()=>{let r;try{r=JSON.stringify(await probe())}catch(e){r=JSON.stringify({fatal:e.message+' '+e.stack});if(ONE)parent.postMessage({one:{a:ONE,ok:false,changed:false,status:'',missing:[],errors:['fatal: '+e.message]}},'*')}const p=document.createElement('pre');p.id='CLICK';p.textContent=r;document.body.append(p)},500)</script></body>"%probe)
open(tmp+"/page.html","w").write(h)
PY
  for pass in $passes; do
    if [[ $pass == cold ]]; then
      # The action list comes from the warm pass when it ran, else from a quick listing run.
      if [[ ! -s $tmp/dom-$kind-warm.html ]]; then
        if ! dump_chrome "$kind cold action listing" "$tmp/dom-$kind-warm.html" --headless=new $gpuflag --no-first-run --allow-file-access-from-files --user-data-dir=$tmp/profile-$kind-list \
          --window-size=1440,900 --virtual-time-budget=${VTB:-120000} --dump-dom "file://$tmp/page.html"; then
          fail=1; continue
        fi
      fi
      python3 - "$tmp" "$kind" "${cold_real[@]}" <<'PY' || { print "$kind cold: no action list"; fail=1; continue; }
import sys,re,html,json
from pathlib import Path
tmp,kind,*real=sys.argv[1:]
m=re.search(r'<pre id="CLICK">(.*?)</pre>',open(tmp+"/dom-%s-warm.html"%kind).read(),re.S)
acts=json.loads(html.unescape(m.group(1)))["actions"]
Path(tmp, "cold-actions.json").write_text(json.dumps(acts))
driver='''<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
const acts=%s,out=[];
let running=false;
async function runCold(){
  if(running)throw Error("Cold actions already started");
  running=true;
  for(const a of acts){console.info("click-through cold action "+a);const f=document.createElement("iframe");f.style.cssText="border:0;width:1440px;height:900px";
  const r=await new Promise(res=>{const t=setTimeout(()=>res({a,ok:false,changed:false,status:"",missing:[],errors:["no result (page did not finish)"]}),60000);
    onmessage=e=>{if(e.data&&e.data.one&&e.data.one.a===a){clearTimeout(t);res(e.data.one);}};f.src="page.html#one="+encodeURIComponent(a);document.body.append(f);});
  f.remove();out.push(r);}
  const p=document.createElement("pre");p.id="CLICK";p.textContent=JSON.stringify({kind:%s,via:"",pass:"cold",count:out.length,results:out});document.body.append(p);return p.textContent;
}
%s
</script>'''
for page, actions in (("cold", [a for a in acts if a not in real]), ("cold-real", [a for a in acts if a in real])):
    path=Path(tmp, page+".html")
    if actions or page == "cold":
        path.write_text(driver % (json.dumps(actions), json.dumps(kind), "runCold();" if page == "cold" else ""))
    else:
        path.unlink(missing_ok=True)
PY
      # Browser workers and cold inspector/panel setup can lag behind Chromium virtual time.
      # Keep those frames alive on a real clock until the request has an observable outcome.
      if [[ -f $tmp/cold-real.html ]]; then
        if ! capture "$kind cold outputs" "$tmp/dom-$kind-cold-real.html" python3 "$root/scripts/click-through-real.py" \
          "$chrome" "$gpuflag" "$tmp/profile-$kind-cold-real" "$tmp/cold-real.html" "$wall"; then
          fail=1; continue
        fi
      fi
      if ! dump_chrome "$kind cold" "$tmp/dom-$kind-cold.html" --headless=new $gpuflag --no-first-run --allow-file-access-from-files --user-data-dir=$tmp/profile-$kind-cold \
        --window-size=1440,900 --virtual-time-budget=${COLD_VTB:-1200000} --dump-dom "file://$tmp/cold.html"; then
        fail=1; continue
      fi
    else
      if ! dump_chrome "$kind warm" "$tmp/dom-$kind-warm.html" --headless=new $gpuflag --no-first-run --allow-file-access-from-files --user-data-dir=$tmp/profile-$kind \
        --window-size=1440,900 --virtual-time-budget=${VTB:-120000} --dump-dom "file://$tmp/page.html"; then
        fail=1; continue
      fi
    fi
    python3 - "$tmp/dom-$kind-$pass.html" "$json" "$via" <<'PY' || fail=1
import sys,re,html,json
from pathlib import Path
def read_result(path):
    m=re.search(r'<pre id="CLICK">(.*?)</pre>',path.read_text(),re.S)
    if not m: sys.exit("no result (page did not finish)")
    return json.loads(html.unescape(m.group(1)))
path=Path(sys.argv[1])
r=read_result(path)
if "fatal" in r: print("FATAL",r["fatal"]); sys.exit(1)
if r["pass"]=="cold":
    real=path.with_name(path.stem+"-real.html")
    rows=r["results"]+(read_result(real)["results"] if real.is_file() else [])
    order=json.loads(path.with_name("cold-actions.json").read_text())
    by_action={row["a"]:row for row in rows}
    if len(by_action)!=len(rows) or by_action.keys()!=set(order):
        sys.exit("cold actions returned duplicate or missing results")
    r.update(count=len(order),results=[by_action[a] for a in order])
if sys.argv[2]=="1": print(json.dumps(r,indent=1))
bad=[x for x in r["results"] if not x.get("skip") and not x["ok"]]
skipped={}
for row in r["results"]:
    if row.get("skip"):
        skipped.setdefault(row["skip"],[]).append(row["a"])
skips=sum(map(len,skipped.values()))
details="; ".join(reason+": "+" ".join(actions) for reason,actions in skipped.items())
print("%s via %s (%s): %d actions, %d passed, %d failed, %d skipped%s"%(r["kind"],sys.argv[3],r["pass"],r["count"],r["count"]-len(bad)-skips,len(bad),skips," ("+details+")" if details else ""))
if r.get("renderer"): print("  board renderer: %s"%r["renderer"])
for x in bad: print("  FAIL %-24s changed=%s status=%r missing=%s errors=%s"%(x["a"],x["changed"],x["status"],x.get("missing"),x["errors"]))
sys.exit(1 if bad else 0)
PY
  done
done
exit $fail
