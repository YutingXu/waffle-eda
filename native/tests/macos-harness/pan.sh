#!/bin/zsh
# Trackpad pan in WKWebView (the macOS app's engine), through the real Desktop class: pan-probes.js sends
# real macOS scroll events (continuous pixel deltas, scroll and momentum phases, 120 Hz, mixed axes) and
# measures frame intervals, main-thread work per wheel event, texture uploads and net label placements per
# pan frame, and blank pixels of the last pan frame against the exact frame, at fit, x4 and x14, on both
# board renderers. Boards: the PiDP-11 fixture, plus PAN_BOARD=file[,file...] (an Altium project's files,
# read here and piped to the page; nothing is copied).
# Usage: native/tests/macos-harness/pan.sh [work-folder]   (numbers: <work-folder>/pan-probes.json)
# Env: PAN_RENDERERS=gpu,2d and PAN_ZOOMS=fit,mid,close choose the runs (default all).
#      HARNESS_INSTALL as for frame.sh (a real path outside /tmp and /var). PAN_TIMEOUT (default 900 s).
# Budgets (PAN_BUDGET_FRAME, _WORK, _BLANK): frame interval p95 within 1.5 refresh intervals, work per
# wheel event p95 <= 4 ms, blank <= 1 % of pixels.
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-pan}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-pan}
mkdir -p $W/run
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
log=$W/pan.log; : > $log
fixture=$ROOT/tests/fixtures/altium/pidp11-io-expander
# One app launch per board (a second import would ask about replacing the first).
for board in "$fixture/PCB-PiDP11IOExpander.PrjPcb,$fixture/PiDP11IOExpander.PcbDoc" ${PAN_BOARD:-}; do
  python3 - "$board" <<'PY' | \
    HARNESS_INPUT_STDIN=1 HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_EARLY_PROBE=$H/pan-early.js HARNESS_PROBES=$H/pan-probes.js HARNESS_WORK=$W/run \
    timeout ${PAN_TIMEOUT:-900} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E "^(PASS|FAIL|NOTE|RESULT)" >> $log
import sys, json, base64, os
boards = []
for arg in sys.argv[1:]:
    files = [f for f in arg.split(",") if f]
    pcb = next((f for f in files if f.lower().endswith(".pcbdoc")), files[0])
    boards.append({"name": os.path.basename(pcb), "files": [{"name": os.path.basename(f), "data": base64.b64encode(open(f, "rb").read()).decode()} for f in files]})
pick = lambda k: [x for x in os.environ.get(k, "").split(",") if x] or None
sys.stdout.write(json.dumps({"boards": boards, "renderers": pick("PAN_RENDERERS"), "zooms": pick("PAN_ZOOMS"), "shots": os.environ.get("PAN_SHOTS") == "1"}))
PY
done
grep -E "^(FAIL|RESULT)|WebKit.framework|60fps" $log | sort -u
python3 - "$log" "$W/pan-probes.json" <<'PY'
import sys, json, re, os
text = open(sys.argv[1]).read()
runs = [json.loads(m) for m in re.findall(r'PAN (\{.*\})', text)]
if not runs: print("FAIL  pan probe produced numbers"); print(text[-2000:]); sys.exit(1)
r = runs[0]
for x in runs[1:]: r["boards"].update(x["boards"])
open(sys.argv[2], "w").write(json.dumps(r, indent=1))
bf, bw, bb = (float(os.environ.get("PAN_BUDGET_" + k, d)) for k, d in (("FRAME", 1.5), ("WORK", 4), ("BLANK", .01)))
interval = 1000 / r["refreshHz"]; bad = 0
print("WKWebView trackpad pan, refresh %s Hz" % r["refreshHz"])
for name, B in r["boards"].items():
    if "error" in B: print("FAIL  %s: %s" % (name, B["error"])); bad += 1; continue
    print("  %s (%s objects), event offset %s, target %s rect %s" % (name, B["items"], B.get("offset"), B.get("target"), B.get("rect")))
    for which in ("gpu", "2d"):
        rows = B.get(which)
        if isinstance(rows, dict): print("    %s: skipped (%s)" % (which, rows.get("skipped"))); continue
        for x in rows or []:
            if "error" in x: print("FAIL    %s %s: %s" % (which, x["name"], x["error"])); bad += 1; continue
            f, w = x["frame"], x["work"]
            ok = f["p95"] <= bf * interval and w["p95"] <= bw and x.get("blank") is not None and x["blank"] <= bb and x["events"] > 100
            bad += not ok
            print("%s    %-3s %-5s frame p50 %s p95 %s max %s ms, %s/%s dropped; work/event p50 %s p95 %s max %s ms (%s events, %s cancelable); render p50 %s p95 %s max %s ms over %s renders (%s exact); %s KB uploaded per pan frame, %s label placements, %s wide copies; blank %s%%"
                  % ("PASS" if ok else "FAIL", which, x["name"], f["p50"], f["p95"], f["max"], f["dropped"], f["frames"], w["p50"], w["p95"], w["max"], x["events"], x["cancelable"],
                     x["render"]["p50"], x["render"]["p95"], x["render"]["max"], x["renders"], x["exactDuring"], x["uploadKB"], x["labelFrames"], x["wideBuilds"],
                     "-" if x.get("blank") is None else round(x["blank"] * 100, 2)))
print("%s  WebKit trackpad pan budgets (frame p95 <= %g refresh intervals, work/event p95 <= %g ms, blank <= %g %%)" % ("FAIL" if bad else "PASS", bf, bw, bb * 100))
sys.exit(1 if bad else 0)
PY
rc=$?
grep "^RESULT" $log | grep -qv "^RESULT ok" && rc=1
exit $rc
