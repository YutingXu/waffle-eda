#!/bin/zsh
# WebKit UI probes: the real Desktop class and WKWebView (the macOS app's engine), driven with real
# AppKit mouse and key events. Checks the menus and submenus with their keyboard navigation, the
# object context menus, closed dialogs, sticky dialog footers, colour tokens and color-mix() in
# every theme, the CSS mask close icon, the Filter panel and Navigator, Ctrl/⌘/Alt+click net
# highlight, the Shift+W/Shift+V choosers, Place › Power Port and Help › What's New links, and
# parses every app stylesheet with WebKit. When Chrome is installed it runs the same CSS audit
# there and reports only what WebKit drops and Chrome keeps.
# Uses a non-persistent WebKit data store, its own bundle id (org.waffle.editor.harness) and a
# scratch support folder.
# Usage: native/tests/macos-harness/ui.sh [work-folder]   (screenshots: <work-folder>/run/shots)
# Env: HARNESS_INSTALL  where the app bundle goes (default ~/Library/Caches/atrium-harness-ui). It must
#      be a real path outside /tmp and /var: the app standardises its page URL, which drops /private,
#      and WebKit then refuses the page. native/tests/macos-harness/target/ is a safe in-repo choice
#      (package-release.py skips "target" folders); delete it afterwards.
#      UI_TIMEOUT (default 900 s; a full run takes about 2 minutes), CHROME (the baseline for the CSS audit),
#      UI_ONLY=menus,context (a comma-separated subset of the probes named in ui-probes.js run()).
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-ui}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-ui}
mkdir -p $W
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
# UI_PROJECT=design.waffle: the camera probes also run on that design (globalThis.__uiProject); it stays in the work folder.
pre=""
if [[ -n ${UI_PROJECT:-} ]]; then python3 -c 'import json,sys;print("globalThis.__uiProject="+json.dumps(open(sys.argv[1]).read())+";")' $UI_PROJECT > $W/project.js || exit 2; pre=$W/project.js:; fi
native_log=$(mktemp "$W/native-ui-result.XXXXXX") || exit 2
trap 'rm -f "$native_log"' EXIT
UI_ONLY=${UI_ONLY:-} HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_PROBES=$pre$H/css-audit.js:$H/ui-probes.js HARNESS_WORK=$W/run \
  timeout ${UI_TIMEOUT:-900} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E '^(PASS|FAIL|SKIP|NOTE|RESULT)' | tee "$native_log"
native_status=("${pipestatus[@]}")
rc=${native_status[1]}
# The native app can close with status 0 even after a failed probe.
if (( rc == 0 )) && {
  (( native_status[2] || native_status[3] )) ||
  grep -q '^FAIL' "$native_log" ||
  ! grep -qx 'RESULT ok' "$native_log"
}; then
  rc=1
fi
# Chrome baseline for the CSS audit: a declaration or rule WebKit drops is a WebKit gap only when Chrome keeps it.
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
if [[ -x $chrome && -s $W/run/css-audit-webkit.json ]]; then
  python3 - "$ROOT/app" "$H/css-audit.js" "$W" <<'PY'
import sys, json
from pathlib import Path
app, audit, w = sys.argv[1:4]
sys.path.insert(0, str(Path(app).parent / "scripts"))
from asset_files import app_source_files
src = {f.relative_to(app).as_posix(): f.read_text(encoding="utf-8") for f in app_source_files(app, "*.css")}
h = open(app + "/index.html").read()
# The real app page (as scripts/click-through.sh builds it), so the themes and their tokens are the app's own.
h = h.replace("<head>", '<head><base href="file://%s/">' % app, 1)
h = h.replace("</body>", '<script>%s\n</script><script>setTimeout(()=>globalThis.__cssAudit.run(%s).then(r=>{const p=document.createElement("pre");p.id="OUT";p.textContent=JSON.stringify(r);document.body.append(p)},e=>{const p=document.createElement("pre");p.id="OUT";p.textContent=JSON.stringify({fatal:String(e&&e.stack||e)});document.body.append(p)}),1500)</script></body>'
              % (open(audit).read(), json.dumps(src).replace("</", "<\\/")), 1)
page = h
open(w + "/css-audit-chrome.html", "w").write(page)
PY
  "$chrome" --headless=new --disable-gpu --no-first-run --user-data-dir=$W/chrome-profile --allow-file-access-from-files --window-size=1380,860 --virtual-time-budget=60000 \
    --dump-dom "file://$W/css-audit-chrome.html" 2>/dev/null > $W/css-audit-chrome.dom
  python3 - "$W" <<'PY' || { (( rc )) || rc=1; }
import sys, json, re, html
w = sys.argv[1]
m = re.search(r'<pre id="OUT">(.*?)</pre>', open(w + "/css-audit-chrome.dom").read(), re.S)
if not m: print("FAIL  CSS audit ran in Chrome"); sys.exit(1)
c = json.loads(html.unescape(m.group(1)))
if "fatal" in c: print("FAIL  CSS audit in Chrome: " + c["fatal"][:300]); sys.exit(1)
k = json.load(open(w + "/run/css-audit-webkit.json"))
key = lambda x: (x["file"], x["selector"], x.get("prop", ""))
cd = {key(x) for x in c["dropped"]}; cr = {(x["file"], x["selector"]) for x in c["droppedRules"]}
onlyR = [x for x in k["droppedRules"] if (x["file"], x["selector"]) not in cr]
onlyD = [x for x in k["dropped"] if key(x) not in cd and (x["file"], x["selector"]) not in {(r["file"], r["selector"]) for r in onlyR}]
ce = {(x["theme"], x["expr"]) for x in c["invalid"]}
onlyC = [x for x in k["invalid"] if (x["theme"], x["expr"]) not in ce]
for x in onlyR: print("NOTE  WebKit drops rule %s  %s" % (x["file"], x["selector"][:160]))
for x in onlyD: print("NOTE  WebKit drops %s  %s { %s: %s }  supports=%s" % (x["file"], x["selector"][:100], x["prop"], x["value"][:100], x.get("supports")))
for x in onlyC: print("NOTE  WebKit cannot compute %s in %s: %s" % (x["expr"][:120], x["theme"], x.get("got")))
print("%s  CSS audit vs Chrome: %d rules, %d declarations, %d colour expressions only WebKit drops (Chrome: %d rules, %d declarations parsed)"
      % ("PASS" if not (onlyR or onlyD or onlyC) else "FAIL", len(onlyR), len(onlyD), len(onlyC), c["rules"], c["declarations"]))
sys.exit(1 if (onlyR or onlyD or onlyC) else 0)
PY
else print "NOTE  Chrome not found or no WebKit CSS audit; skipped the Chrome comparison"; fi
exit $rc
