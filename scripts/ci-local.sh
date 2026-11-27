#!/bin/zsh
# macOS CI: exactly the steps .github/workflows/ci.yml runs on the self-hosted macOS runner, so a
# local run and CI stay identical. Needs Xcode command-line tools, python3 and Google Chrome (or
# Chromium; set CHROME=...). No Node needed: JS suites run under the system JavaScriptCore.
#
# Usage: scripts/ci-local.sh [step ...]     (no steps = all, in this order)
#   jsc      scripts/test-jsc.sh; fails only on suites not in tests/known-failures.txt
#            (includes the end-to-end fidelity fast tier, tests/integration/e2e-fidelity.cjs, on the vendored PiDP-11 board)
#   e2e      end-to-end fidelity, full tier: tests/e2e/run.py --fetch --mutations (pinned Altium and KiCad
#            corpora fetched outside the checkout; import -> model vs an independent reader -> outputs vs
#            the original tool's files -> render -> native round trip; known failures in
#            tests/e2e/known-failures.json). Uses the pinned Node (installed like typecheck's).
#            WAFFLE_E2E_PRIVATE=/folder adds a local private corpus (never printed or committed).
#   mcp      tests/automation/mcp.py, mcp_runner.py, headless-parity.py, eco-e2e.py
#            and the feature MCP suites (diff, review, MCAD, authoring, bus route, generic parts, symbol wizard, fab parity, collab relay, Git security, model types, ngspice)
#   static   CSS tokens, UI library lint, reachability, shortcuts, startup budget, generated assets and Git hygiene,
#            extension registry publisher, VS Code schema/viewer and typecheck
#            (scripts/typecheck.sh: tsc over types/baseline.json; installs the pinned Node and
#            TypeScript under ~/.cache/atrium-ci on first use)
#   swift    typecheck native/macos, build the universal ad hoc signed app (scripts/build-mac.sh)
#            into a scratch folder, native/tests/*.py
#   windows  cross-build the Windows host: its shared-core tests, then the portable zip
#            (scripts/build-windows.sh), with a pinned .NET 8 SDK installed in user space
#            (scripts/ci/install-dotnet.sh; DOTNET=/path/to/dotnet to use another)
#   harness  native/tests/macos-harness/run.sh (needs a logged-in GUI session)
#   click    scripts/click-through.sh pcb, then schematic (warm + cold passes)
#   perf     scripts/perf-canvas.sh, scripts/perf-pour.sh (tiled live repour budgets), scripts/perf-view-feel.sh (no blank zoom
#            frames, part-drag work per move), then scripts/perf-ui.sh (UI-shell p95 budgets) and scripts/perf-sch.sh
#            (30-sheet schematic budgets) and scripts/perf-sch.sh --board (idle on the 25.6k-object board, Efficiency
#            mode) and --board pours (small edits on it with ten poured polygons); the last five skipped without a browser
#   gpu      GPU board renderer (app/canvas/canvas-gpu.js): the pixel test against the 2D renderer in Chrome with
#            its GPU (scripts/gpu-pixels.sh) and in WKWebView (native/tests/macos-harness/gpu-pixels.sh,
#            needs a logged-in GUI session), geometry on each moving frame, isolated WebKit GPU-process recovery, and then click-through
#            pcb with Renderer: GPU. The self-hosted job requires hardware for the retained copper
#            and allocation lifecycle test. Local machines without WebGL2 can skip it explicitly.
#   rust     Rust/WebAssembly kernels: cargo test, app/engine-core.js is a bit-for-bit fresh build
#            (scripts/build-engine.py --check), then the equivalence suites with ATRIUM_ENGINE=wasm
#            and =js. The pinned toolchain is installed in user space (scripts/ci/install-rust.sh;
#            CARGO=/path/to/cargo to use another).
# Every step runs to the end; the exit status is 1 when any check failed.
root=${0:A:h:h}
cd $root || exit 2
steps=("$@"); (( $#steps )) || steps=(jsc e2e rust mcp static swift windows harness click perf gpu)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/atrium-ci.XXXXXX"); trap 'rm -rf $scratch' EXIT HUP INT TERM
export PYTHONDONTWRITEBYTECODE=1
fail=0 summary=()
gh=${GITHUB_ACTIONS:-}
run() { # run LABEL CMD...
  local label=$1; shift
  [[ -n $gh ]] && print "::group::$label" || print -r -- "--- $label"
  local t0=$SECONDS; "$@"; local rc=$?
  [[ -n $gh ]] && print "::endgroup::"
  if (( rc == 0 )); then summary+=("PASS  $label ($((SECONDS - t0))s)")
  else summary+=("FAIL  $label (exit $rc, $((SECONDS - t0))s)"); fail=1
    [[ -n $gh ]] && print "::error::$label failed (exit $rc)"; fi
  return 0
}
jsc_known() {
  python3 tests/jsc-runner.py || return 1
  scripts/test-jsc.sh > $scratch/jsc.log
  cat $scratch/jsc.log
  python3 scripts/ci/check-results.py jsc $scratch/jsc.log
}
e2e_full() {
  local node=${NODE:-} ver
  if [[ -z $node ]]; then
    ver=$(sed -n 's/^NODE_VERSION=//p' scripts/ci/install-node.sh)
    node=${ATRIUM_CI_CACHE:-$HOME/.cache/atrium-ci}/node-$ver/bin/node
    [[ -x $node ]] || PREFIX=${node:h:h} sh scripts/ci/install-node.sh >&2 || return 1
  fi
  local rc=0
  python3 tests/e2e/run.py --node $node --fetch --mutations || rc=$?
  # Repour the fetched boards against the fill their tools stored (tests/formats/pour-oracle.cjs).
  $node tests/formats/pour-oracle.cjs --require-corpus || rc=1
  return $rc
}
rust_build() {
  local cargo=${CARGO:-}
  if [[ -z $cargo ]]; then
    export CARGO_HOME=${CARGO_HOME:-$HOME/.cache/atrium-rust/cargo} RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.cache/atrium-rust/rustup}
    cargo=$(scripts/ci/install-rust.sh) || return 1
  fi
  CARGO=$cargo python3 scripts/build-engine.py --check
}
gpu_harness() {
  native/tests/macos-harness/gpu-pixels.sh $scratch/gpu-pixels   # app bundle: ~/Library/Caches (not /tmp or /var)
}
gpu_pour_lod() {
  local node_bin=${NODE:-${commands[node]:-}} cache=${ATRIUM_CI_CACHE:-$HOME/.cache/atrium-ci} version lock_hash
  local -a args
  [[ -n $gh ]] && args+=(--require-hardware)
  if [[ -z $node_bin ]]; then
    version=$(sed -n 's/^NODE_VERSION=//p' scripts/ci/install-node.sh)
    node_bin=$cache/node-$version/bin/node
  fi
  if [[ ! -x $node_bin ]]; then
    [[ -n $gh ]] && { print -u2 "GPU pour regression requires Node"; return 1; }
    print "SKIP browser-gpu-pour-lod: Node is unavailable."
    return 0
  fi
  lock_hash=$(shasum -a 256 scripts/ci/package-lock.json | cut -c1-12)
  NODE_PATH="${NODE_PATH:+$NODE_PATH:}$root/scripts/ci/node_modules:$cache/ci-node-$lock_hash/node_modules" \
    "$node_bin" tests/canvas/browser-gpu-pour-lod.cjs "${args[@]}"
}
rust_equivalence() { local m; for m in wasm js; do ATRIUM_ENGINE=$m scripts/test-jsc.sh engine engine-pour pour-fuzz pour-fuzz-board drc-equivalence connectivity || return 1; done; }
swift_typecheck() {
  xcrun swiftc -typecheck -swift-version 5 -target arm64-apple-macos12.0 -module-cache-path $scratch/swift-cache \
    native/macos/main.swift native/macos/FolderTransactions.swift native/macos/FolderWatch.swift native/macos/ProjectWrites.swift native/macos/HostState.swift native/macos/ExternalTools.swift native/macos/LanRelay.swift native/macos/NotebookMedia.swift native/macos/NotebookFolderMedia.swift
}
folder_transactions() {
  xcrun swiftc -O -swift-version 5 -module-cache-path "$scratch/swift-cache" \
    native/macos/FolderTransactions.swift native/tests/folder-transaction/main.swift -o "$scratch/folder-transaction" &&
    python3 native/tests/folder-transaction/macos.py "$scratch/folder-transaction"
}
# run.sh can exit 0 although the harness printed FAIL lines ("RESULT 3 failed"), so judge its output.
harness() {
  native/tests/macos-harness/run.sh $scratch/harness | tee $scratch/harness.log
  local rc=${pipestatus[1]}
  (( rc == 0 )) && grep -q '^RESULT ok' $scratch/harness.log && ! grep -q '^FAIL' $scratch/harness.log || return 1
  HARNESS_REUSE_APP=1 HARNESS_SUITE=field-text native/tests/macos-harness/run.sh $scratch/field-text
}
windows_build() {
  local dotnet=${DOTNET:-}
  [[ -n $dotnet ]] || dotnet=$(scripts/ci/install-dotnet.sh) || return 1
  DOTNET=$dotnet scripts/build-windows.sh $scratch/dist-windows && ls $scratch/dist-windows/Waffle-*-windows.zip
}
build_app() {
  scripts/build-mac.sh $scratch/dist && test -x $scratch/dist/Waffle.app/Contents/MacOS/Waffle &&
  lipo -archs $scratch/dist/Waffle.app/Contents/MacOS/Waffle && codesign --verify --strict $scratch/dist/Waffle.app &&
  for f in mcp/*.py mcp/*.js; do cmp -s $f $scratch/dist/Waffle.app/Contents/Resources/$f || { print -u2 "app bundle lacks $f"; return 1; }; done
}

python3 -B scripts/prepare-assets.py || exit 2

for step in $steps; do
  case $step in
    jsc)     run "test-jsc vs tests/known-failures.txt" jsc_known ;;
    e2e)     run "end-to-end fidelity, full tier (fetched corpora, render, mutations)" e2e_full ;;
    mcp)     for test_path in tests/automation/mcp.py tests/automation/mcp_runner.py tests/automation/headless-parity.py tests/integration/eco-e2e.py tests/formats/compat-mcp.py tests/project/mcp-source-save.py tests/history/mcp_diff.py tests/history/mcp_review.py tests/formats/mcad-mcp.py tests/automation/mcp-authoring.py tests/automation/mcp-signals.py tests/pcb/mcp-bus-route.py tests/library/mcp-generic-parts.py tests/library/mcp-symbol-wizard.py tests/formats/altium-fab-parity-mcp.py tests/project/collab-relay.py tests/project/security-git.py tests/automation/security-proposals.py tests/maintenance/types-model.py tests/notebook/notebook-media-license.py tests/analysis/si-ngspice.py; do run "tests/${test_path##*/}" python3 "$test_path"; done
             run "batch DRC parity in CLI and MCP" python3 -B tests/checks/mcp-drc-parity.py
             run "native compatibility corpus in CLI and MCP" python3 tests/formats/mcp-format-2.py
             run "Slides in CLI and MCP" python3 tests/automation/butter-acceptance.py --feature slides
             run "Slides vector PDF and presenter state in MCP" python3 tests/notebook/butter-slides.py
             run "ODB++ opt-in and native output routes" python3 tests/formats/butter-odb.py
             run "Butter tables on the native MCP transport" python3 -B tests/automation/mcp-butter-tables.py
             run "native project Git snapshots" python3 tests/formats/format-2-git.py
             run "plain Git and Waffle document merges" python3 tests/formats/format-2-document-merge.py ;;
    static)  if [[ -e .git ]]; then
               run "tracked source roots" python3 -B scripts/check-source-roots.py
               run "retired documentation links" python3 -B tests/maintenance/retired-doc-links.py
             else
               print "SKIP tracked source roots: source archive"
             fi
             run "public tree privacy tests" python3 -B tests/maintenance/public-tree.py
             run "tests/maintenance/css-tokens.py" python3 tests/maintenance/css-tokens.py
             run "UI library lint" python3 -B tests/maintenance/ui-library-lint.py
             run "single geometry owner" python3 -B tests/maintenance/single-owner.py
             run "tests/editor/dialog-inventory.py" python3 tests/editor/dialog-inventory.py
             run "reachability --check" python3 scripts/reachability.py --check
             run "release version mirrors" python3 -B scripts/release-version.py --check
             run "gen-shortcuts --check" python3 scripts/gen-shortcuts.py --check
             run "Apricot palette budget evaluator" python3 -B tests/editor/test-apricot-palette-budget.py
             run "generated files are outside Git" python3 scripts/prepare-assets.py --check-untracked
             run "generated app assets" python3 scripts/prepare-assets.py --check
             run "clean worker build" python3 tests/maintenance/generated-assets.py
             run "i18n-extract tests" python3 tests/maintenance/i18n-extract.py
             run "startup-budget --static" scripts/startup-budget.sh --static
             run "compat-guard --check" python3 scripts/compat-guard.py --check
             run "compat-corpus --check" python3 scripts/compat-corpus.py --check
             run "independent native format reader" python3 tests/formats/format-2-independent-reader.py
             run "generate collaboration installers" python3 scripts/gen-collab-launch.py
             run "gen-collab-launch --check" python3 scripts/gen-collab-launch.py --check
             run "tests/project/collab-server-kit.py" python3 tests/project/collab-server-kit.py
             run "gen-extension-api --check" python3 scripts/gen-extension-api.py --check
             run "extension registry publisher" python3 -B tests/extensions/registry-entry.py
             run "gen-schema --check" python3 integrations/vscode/scripts/gen-schema.py --check
             run "bundle-viewer --check" python3 integrations/vscode/scripts/bundle-viewer.py --check
             run "typecheck (tsc --noEmit, types/baseline.json)" scripts/typecheck.sh ;;
    swift)   run "swift typecheck native/macos" swift_typecheck
             run "macOS folder transaction and conflict recovery" folder_transactions
             run "build-mac.sh (universal, ad hoc)" build_app
             for t in git_head host_state project_journal source_copies project_archive import_save_exports external_tools lan_relay power_saver; do run "native/tests/$t.py" python3 native/tests/$t.py; done ;;
    windows) run "Windows host: core tests + cross-built package" windows_build ;;
    harness) run "macos-harness" harness
             run "macOS component move, Edit menu Undo/Redo and durable reopen" env HARNESS_BACKGROUND=1 native/tests/macos-harness/component-undo.sh "$scratch/component-undo"
             run "macOS saves and recovery without Git" python3 native/tests/folder-transaction/git-independent-desktop.py
             run "Slides second native WKWebView" python3 tests/notebook/slides-presenter-native.py ;;
    click)   run "click-through pcb" scripts/click-through.sh pcb
             run "click-through schematic" scripts/click-through.sh schematic ;;
    perf)    run "perf-canvas" scripts/perf-canvas.sh
             run "perf-pour" scripts/perf-pour.sh
             run "perf-view-feel" scripts/perf-view-feel.sh --skip-if-no-browser
             run "perf-ui" scripts/perf-ui.sh --skip-if-no-browser
             run "perf-sch" scripts/perf-sch.sh --skip-if-no-browser
             run "perf-sch board idle" scripts/perf-sch.sh --board --skip-if-no-browser
             run "perf-sch board edits with pours" scripts/perf-sch.sh --board pours --skip-if-no-browser ;;
    gpu)     run "gpu-pixels (Chrome, GPU vs 2D)" scripts/gpu-pixels.sh --skip-if-no-webgl
             run "Retained copper LOD and GPU allocation recovery" gpu_pour_lod
             run "gpu-pixels (WKWebView, GPU vs 2D)" gpu_harness
             run "Board geometry through zoom in WKWebView" native/tests/macos-harness/zoom-geometry.sh "$scratch/zoom-geometry"
             run "WebKit GPU-process recovery" native/tests/macos-harness/gpu-restart.sh "$scratch/gpu-restart"
             run "click-through pcb, Renderer: GPU" env RENDERER=gpu scripts/click-through.sh pcb ;;
    rust)    run "Rust kernels: cargo test + reproducible engine-core.js" rust_build
             run "Rust kernels: equivalence, ATRIUM_ENGINE=wasm and js" rust_equivalence ;;
    *) print -u2 "unknown step $step (jsc e2e rust mcp static swift windows harness click perf gpu)"; exit 2 ;;
  esac
done
print "\n=== macOS CI summary"; print -l -- $summary
exit $fail
