#!/bin/zsh
# Visual diff budget on the 25,600-object board (tests/pcb/dense-board.js) against a copy with ~300 edits,
# in headless Chrome with CPU raster. Prints, as medians over RUNS fresh launches:
#   firstPaint   AtriumDiffView.start() until both revisions are drawn (before any comparison)
#   compare      the comparison itself (AtriumDiff.compare, synchronous here; the app calls
#                compareAsync, which runs in diff-worker.js on large designs, so it never blocks paint)
#   listPaint    filling the change list, summary and highlights once the changes arrive
#   step         J (next change): select, inspector and a redraw of both panes (reduced motion)
# Fails when firstPaint p50 is over BUDGET_FIRST_PAINT (default 500 ms).
# Usage: scripts/perf-diff.sh [--json] [--measure-only]  Env: CHROME, APP, RUNS=3, BUDGET_FIRST_PAINT=500
root=${0:A:h:h}
json=0; measure=0
for arg in "$@"; do
  case $arg in
    --json) json=1;; --measure-only) measure=1;;
    *) print -u2 "unknown argument $arg"; exit 2;;
  esac
done
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
[[ -x $chrome ]] || { print -u2 "Chrome or Chromium not found; set CHROME=/path/to/chrome"; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-perf-diff.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "${APP:-$root/app}" "$tmp/page.html" <<'PY'
import sys, os
app, out = sys.argv[1:3]
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % app, 1)
extra = "".join('<script src="%s"></script>' % s for s in ["schematic/sch-objects.js", "project/hierarchy.js", "library/component-match.js", "history/diff.js", "history/diff-model.js", "history/diff-props.js", "history/diff-view.js"] if os.path.exists(os.path.join(app, s)))
extra += ''.join('<link rel="stylesheet" href="%s">' % s for s in ["history/diff-props.css", "history/diff-view.css"] if os.path.exists(os.path.join(app, s)))
probe = "const STRIDE=%d;" % int(os.environ.get("EDIT_STRIDE", "97")) + r'''
function probe(){
  document.documentElement.setAttribute("data-motion","reduce");
  for(const d of document.querySelectorAll("dialog[open]"))d.close();
  const {d}=makeAtriumBenchmarkBoard(160);d.id="pcb-dense";d.name="Dense board";
  const P=Atrium.project("Dense",AtriumParts.catalogue);P.documents=[d];
  const P2=JSON.parse(JSON.stringify(P)),d2=P2.documents[0];
  for(let k=0;k<d2.items.length;k+=STRIDE){const i=d2.items[k];if(i.kind==="track")i.width=.3;else if(i.kind==="part")i.x+=1;else if(i.kind==="via")i.x+=.5;}
  d2.items.splice(500,40);
  const V=AtriumDiffView,out={items:d.items.length+d2.items.length};
  let t=performance.now();
  V.start({project:P,label:"Before"},{project:P2,label:"After"},{doc:"pcb-dense"});
  const S=V.session();
  for(const p of S.panes)p.base.getContext("2d").getImageData(0,0,1,1);
  out.firstPaint=+(performance.now()-t).toFixed(1);
  t=performance.now();
  const D=globalThis.AtriumDiff,engine=true;
  const r=D.compare(P,P2,{geometry:true});const list=AtriumDiffModel.fromEngine(r,P,P2);for(const c of list){c.docName="Dense board";c.docKind="pcb";}
  S.model.routing=r.routing||[];
  out.compare=+(performance.now()-t).toFixed(1);out.engine=engine;out.changes=list.length;
  t=performance.now();
  S.model.docs=[{id:"pcb-dense",name:"Dense board",kind:"pcb",side:"both",before:"pcb-dense",after:"pcb-dense"}];
  S.model.add(list,null);S.model.done=true;
  S.token=null; // stop the background comparison started by start()
  V.refresh();V.paint();for(const p of S.panes)p.base.getContext("2d").getImageData(0,0,1,1);
  out.listPaint=+(performance.now()-t).toFixed(1);
  const steps=[];
  for(let i=0;i<10;i++){t=performance.now();V.step(1);V.paint();for(const p of S.panes)p.base.getContext("2d").getImageData(0,0,1,1);steps.push(performance.now()-t);}
  steps.sort((a,b)=>a-b);out.step=+steps[5].toFixed(1);out.steps=steps;
  return out;
}
'''
h = h.replace("</body>", extra + '<script src="../tests/pcb/dense-board.js"></script><script>%s\nlet r;try{r=JSON.stringify(probe())}catch(e){r="ERR "+e.message+" "+e.stack}const p=document.createElement("pre");p.id="MEASURE";p.textContent=r+"\\n"+JSON.stringify(__errs);document.body.append(p)</script></body>' % probe)
open(out, "w").write(h)
PY
for n in {1..${RUNS:-3}}; do
  rm -rf $tmp/prof
  "$chrome" --headless=new --disable-gpu --disable-accelerated-2d-canvas --no-first-run --allow-file-access-from-files \
    --user-data-dir=$tmp/prof --window-size=1440,900 --dump-dom "file://$tmp/page.html" 2>/dev/null > $tmp/run$n.html
done
python3 - "$json" ${BUDGET_FIRST_PAINT:-500} "$measure" $tmp/run*.html <<'PY'
import sys, re, html, json, math, statistics
asjson = sys.argv[1] == "1"; budget = float(sys.argv[2]); measure = sys.argv[3] == "1"; runs = []
for f in sys.argv[4:]:
    m = re.search(r'<pre id="MEASURE">(.*?)</pre>', open(f).read(), re.S)
    if not m: print("no result from the browser"); sys.exit(2)
    body, errs = html.unescape(m.group(1)).split("\n", 1)
    if body.startswith("ERR"): print(body); print(errs); sys.exit(2)
    if measure and json.loads(errs): print("errors while measuring visual diff:", errs); sys.exit(2)
    runs.append(json.loads(body))
keys = ["firstPaint", "compare", "listPaint", "step"]
med = {k: statistics.median(r[k] for r in runs) for k in keys}
res = {"items": runs[0]["items"], "changes": runs[0]["changes"], "engine": runs[0]["engine"], **med, "budgetFirstPaint": budget, "pass": med["firstPaint"] <= budget}
def timing(values):
    p95 = sorted(values)[math.ceil(.95 * len(values)) - 1]
    return {"p50": round(statistics.median(values), 2), "p95": round(p95, 2), "max": round(max(values), 2), "n": len(values)}
res["timings"] = {k: timing([r[k] for r in runs]) for k in keys if k != "step"}
res["timings"]["step"] = timing([value for r in runs for value in r["steps"]])
if asjson: print(json.dumps(res))
else:
    print("diff on %d objects (%d changes, %s): first paint %.1f ms, compare %.1f ms, list %.1f ms, step %.1f ms -> %s (first paint budget %d ms)" % (
        res["items"], res["changes"], "AtriumDiff", med["firstPaint"], med["compare"], med["listPaint"], med["step"], "PASS" if res["pass"] else "FAIL", budget))
sys.exit(0 if measure or res["pass"] else 1)
PY
