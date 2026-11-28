#!/bin/zsh
# Runs standalone suites under macOS's built-in JavaScriptCore.
# Usage: scripts/test-jsc.sh [name ...]   (no names = every module test that runs without Node-only APIs)
# Pass arguments to one suite after -- to also print its output.
root=${0:A:h:h}
jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
[[ -x $jsc ]] || { print -u2 "JavaScriptCore's jsc was not found; use: node tests/run.cjs"; exit 2; }
# JavaScriptCore reads TZ only at start, so suites cannot pin it themselves (tests/support/utc.cjs).
export TZ=UTC
python3 -B "$root/scripts/prepare-assets.py" || exit 2
names=()
while (( $# )) && [[ $1 != -- ]]; do names+=("$1"); shift; done
if (( $# )); then
  shift
  (( ${#names} == 1 )) || { print -u2 "Select one suite before --"; exit 2; }
fi
suite_paths=$(python3 -B "$root/tests/support/suite-paths.py" jsc "${names[@]}") || exit 2
test_paths=("${(@f)suite_paths}")
fail=0
# ATRIUM_ENGINE=js|wasm forces the JS fallbacks or the Rust/WebAssembly kernels (app/engine-core.js).
engine=(); [[ ${ATRIUM_ENGINE:-} == (js|wasm) ]] && engine=(-e "globalThis.ATRIUM_ENGINE=\"$ATRIUM_ENGINE\"")
# Walk the checkout once in Node and hand the same sorted basename inventory to every
# JavaScriptCore suite. The shim can read this named file. It still refuses to
# enumerate a real directory, including app/.
inventory_prelude=()
resolver=$root/tests/support/app-source-paths.cjs
if [[ -f "$resolver" && -d "$root/app" ]]; then
  app_inventory=$(mktemp)
  trap 'rm -f "$app_inventory"' EXIT
  node -e '
    const {inventoryFrom} = require(process.argv[1]);
    const rows = [...inventoryFrom()].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    process.stdout.write(JSON.stringify(rows));
  ' "$resolver" >"$app_inventory" || exit 2
  inventory_prelude=(-e "globalThis.ATRIUM_APP_SOURCE_INVENTORY_FILE=\"$app_inventory\"")
fi
for test_path in $test_paths; do
  n=${test_path:t:r}
  [[ $n == jsc-shim || $n == run ]] && continue
  # These suites exercise host APIs beyond the JSC shim. The Node inventory runs them.
  case $n in
    apricot-native-pidp-scopes) reason="writes and reopens physical project, model and retained-source files in a Node temporary directory" ;;
    ai) reason="requires Node filesystem writes and a child process" ;;
    import-worker|live-pour-worker) reason="requires Node worker threads" ;;
    diff-worker) reason="requires URL to place diff-worker.js beside diff.js (the Node inventory runs it)" ;;
    altium-links) reason="requires URL to check link addresses (the Node inventory runs it)" ;;
    integration-browser|collab-pair-browser|collab-remote-scope-browser|palette-actions.browser|browser-apricot-readonly|browser-apricot-native-query|browser-import-export-target|browser-butter-ai|butter-macros-browser|browser-butter-ai-ui|browser-butter-query-ui|browser-butter-macros-ui|browser-butter-links-ui|butter-intel-ui-shared|browser-library-drag|browser-owner-layers|browser-route-no-op|browser-scripting-console|browser-step-worker|browser-wire-finish) reason="requires Node, Playwright and Chromium" ;;
    browser-format-2-git|browser-butter-history) reason="requires Node child processes, Playwright, Chromium, Python 3 and Git (runs in Chromium CI)" ;;
    browser-dialog-geometry|browser-dialog-safe-area|browser-titlebar-safe-area|browser-surface-motion|browser-workbench-spatial|browser-dock-beta|browser-ui-gallery|browser-ui-snapshots) reason="requires Node and real Chromium layout, focus and animations" ;;
    browser-gpu-pour-lod) reason="runs in the GPU CI step with Node, Playwright and hardware WebGL2" ;;
    native-palette-extension-detail) reason="requires Node to build and drive the macOS AppKit/WKWebView harness" ;;
    collab-transport) reason="requires Web Crypto for authenticated encryption and signatures (the Node job runs it)" ;;
    collab-pair) reason="requires Web Crypto and compression streams (the Node job runs it)" ;;
    collab-resilience) reason="runs each editor in its own Node vm context (the Node job runs it)" ;;
    notebook-foreign) reason="uses Node zlib to independently verify retained PNG bytes" ;;
    odb-output|odb-profile-conformance) reason="uses Node zlib to independently verify ODB++ gzip and tar bytes (runs in the Node suites)" ;;
    notebook-font-assets) reason="uses the Node crypto digest to verify the asset provider" ;;
    revision-performance) reason="requires Node child processes and process CPU and memory measurements" ;;
    add-existing-live|collab-session|folder-project-editor|integration|library-ui|library-sources-ui|revision-geometry|revision-ui|selection-edit|workbench|cohesion-ui|doc-views|doc-tabs-ui) reason="requires the Node LinkeDOM test environment" ;;
    sch-restore-ui|wire-edit-ui) reason="requires Node, LinkeDOM and the external Level.Shifter.SchDoc fixture" ;;
    source-copy-ui) reason="requires Node, LinkeDOM and the external Level.Shifter.SchDoc and qfsae-0.PcbDoc fixtures" ;;
    *) reason= ;;
  esac
  if [[ -n $reason ]]; then print "SKIP  $n: $reason"; continue; fi
  # Per-test time limit (JSC_TEST_TIMEOUT seconds, default 180) so one hung suite cannot block the run.
  test_args=("$@")
  # The standalone JavaScriptCore shell can read files but cannot enumerate a real directory.
  [[ $n == motion ]] && test_args+=(--css-files "$root"/app/**/*.css(N.))
  out=$(perl -e 'alarm shift; exec @ARGV' ${JSC_TEST_TIMEOUT:-180} $jsc $engine $inventory_prelude $root/tests/jsc-shim.js -- "$root/$test_path" $test_args 2>&1); rc=$?
  (( $# )) && print -r -- "$out"
  completed= failure= reported_exit=
  for line in "${(@f)out}"; do
    case $line in
      "SHIM-OK $n.cjs") completed=1 ;;
      SHIM-FAIL*) [[ -n $failure ]] || failure=$line ;;
      "SHIM-EXIT 0") reported_exit= ;;
      "SHIM-EXIT "*) reported_exit=${line#SHIM-EXIT } ;;
    esac
  done
  if (( rc == 142 )); then failure="timed out after ${JSC_TEST_TIMEOUT:-180}s"
  elif (( rc != 0 )) && [[ -z $failure ]]; then failure="JavaScriptCore exited with status $rc"; fi
  if [[ -n $completed && -z $failure && -z $reported_exit ]]; then print "ok    $n"
  else
    detail=${failure:-${reported_exit:-"test did not finish"}}
    print -r -- "FAIL  $n: ${detail[1,160]}"; fail=1
  fi
done
exit $fail
