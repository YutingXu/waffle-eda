#!/bin/zsh
# PCB view feel budgets in headless Chrome: no blank content while zooming or panning, a part drag's
# work per pointer move, and a trackpad pan's frame interval, work per wheel event and texture uploads,
# on the PiDP-11 board for the GPU and 2D renderers. The probe and its budgets are
# scripts/perf-view-feel.cjs (playwright-core, from node_modules, scripts/ci/node_modules or the pinned
# CI dependencies that scripts/typecheck.sh installs under ~/.cache/atrium-ci).
# Usage: scripts/perf-view-feel.sh [--json] [--skip-if-no-browser]   Env as for perf-view-feel.cjs (CHROME=/path/to/chrome).
#        scripts/perf-view-feel.sh --native --help  (saved PCB on signed WKWebView, --draw-work without physical cadence)
root=${0:A:h:h}
if [[ ${1:-} == --native ]]; then
  shift
  exec python3 "$root/native/tests/macos-harness/label-feel.py" "$@"
fi
args=() skip=0
for a in "$@"; do [[ $a == --skip-if-no-browser ]] && skip=1 || args+=$a; done
node=${commands[node]:-}
[[ -z $node ]] && for n in $HOME/.cache/atrium-ci/node-*/bin/node(N); do node=$n; done
paths=()
for d in $root/node_modules $root/scripts/ci/node_modules $HOME/.cache/atrium-ci/ci-node-*/node_modules(N); do
  [[ -d $d/playwright-core ]] && paths+=$d
done
if [[ -z $node || -z ${CHROME:-} && ! -d "/Applications/Google Chrome.app" && -z ${commands[google-chrome]:-} ]] || (( ! $#paths )); then
  print -u2 "perf-view-feel: needs node, playwright-core and Google Chrome"
  (( skip )) && { print "perf-view-feel: SKIPPED"; exit 0; }
  exit 2
fi
NODE_PATH=${(j.:.)paths} exec $node $root/scripts/perf-view-feel.cjs $args
