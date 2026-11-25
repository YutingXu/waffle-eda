#!/bin/zsh
# Run the shared per-frame geometry checks in the real macOS Desktop class at 2×.
# Usage: zoom-geometry.sh [work-folder]
# Optional: ZOOM_BOARDS=synthetic,demo.kicad_pcb,..., ZOOM_RENDERERS=gpu,2d,
# ZOOM_CASES filters named gestures. ZOOM_BOARD=/path/to/public-board.
# ZOOM_FRAME_IMAGES=1 saves individual frame and reference images.
# HARNESS_INSTALL as in gpu-pixels.sh.
# HARNESS_OPEN_PROJECT=/path/to/project.waffle with ZOOM_NATIVE_BOARD=Name
# tests an existing project through the real Desktop file-open path.
set -eu
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-zoom-geometry}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-zoom-geometry}
mkdir -p "$W"
run=$(mktemp -d "$W/run.XXXXXXXX")
node_path=${commands[node]:-}
if [[ -z $node_path ]]; then
  for installed in "$HOME"/.cache/atrium-ci/node-*/bin/node(N); do node_path=$installed; done
fi
if [[ -z $node_path ]]; then
  print -u2 "The geometry harness needs the Node installation used by the CI tests."
  exit 2
fi
"$node_path" "$ROOT/tests/canvas/browser-zoom-geometry.js" --input > "$W/input.json"
if [[ ${ZOOM_REUSE_HARNESS:-0} != 1 ]]; then
  HARNESS_OUT=$W/build HARNESS_INSTALL=$I "$H/build.sh" > "$W/build.log"
fi
HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_INPUT_STDIN=1 HARNESS_PROBES=$ROOT/tests/canvas/zoom-geometry-probe.js:$H/zoom-geometry-probes.js HARNESS_WORK=$run \
  timeout 300 "$I/WaffleHarness.app/Contents/MacOS/Waffle" < "$W/input.json" > "$W/webkit.log" 2>&1
python3 - "$W" "$run" <<'PY'
import base64, json, pathlib, sys
w, run = map(pathlib.Path, sys.argv[1:])
p = run / "webkit.json"
if not p.exists():
    sys.exit("Missing WKWebView zoom result. See " + str(w / "webkit.log"))
out = json.loads(p.read_text())
(w / "webkit.json").write_text(p.read_text() + "\n")
for p in run.glob("*.png.b64"):
    (w / p.stem).write_bytes(base64.b64decode(p.read_bytes()))
for board, result in out["boards"].items():
    for renderer, runs in result["renders"].items():
        summary = f'{sum(p["moving"] for r in runs for p in r["frames"])} moving frames' if isinstance(runs, list) else runs["skipped"]
        print(f"{board}/{renderer}: {summary}")
if out["dpr"] != 2:
    sys.exit("WKWebView used DPR " + str(out["dpr"]) + ", expected 2.")
if (mutations := out.get("mutations")):
    frames = [frame for row in out["boards"]["synthetic"]["renders"]["gpu"] for frame in row["frames"] if frame.get("mutated")]
    if [frame["mutated"] for frame in frames] != mutations:
        sys.exit("Each injection must affect exactly one moving frame.")
    for frame in frames:
        target = "track" if frame["mutated"] == "one-frame" else frame["mutated"]
        if not frame["moving"] or not frame.get("loss", {}).get(target, {}).get("loss"):
            sys.exit("Did not catch the injected moving-frame loss for " + target)
if out["failures"]:
    print(json.dumps(out["failures"][:20]))
    sys.exit(1)
PY
