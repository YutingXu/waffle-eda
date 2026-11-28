#!/bin/sh
# One Linux CI step, run INSIDE a container started by scripts/ci-linux.sh. The checkout is mounted
# read-only at /src and copied to the writable tmpfs /work, so nothing is written back to the host
# except the explicit artifacts in /out (package and soak steps).
# Usage (in the container): linux-steps.sh STEP
#   node       Node suites that do not need the Chromium image (known failures filtered)
#   mcp        MCP tests, headless parity and the ECO end-to-end flow (JavaScriptCore-GTK and Node)
#   static     design tokens, shortcuts doc, eager-JS budget, generated bundles, VS Code schema,
#              type check (scripts/typecheck.sh, TypeScript from the image's lockfile install)
#   native     Python syntax of the Linux host, MCP and scripts; native/tests/*.py
#   webkitgtk  WebKitGTK web view boots the editor; native/linux/waffle.py starts and stays up;
#              the WebKit UI probes (native/tests/linux-harness/ui.py) with real X input
#   deb        build the .deb into /out and inspect it (native/tests/debian_package.py)
#   deb-install  test the package rename, install the package from /out and run the commands
#   soak       quick-fix retention and the five-minute editing session (Chromium image)
#   rust       cargo test and the reproducible build check of app/engine-core.js (rust image)
#   browser    reachability (needs Chromium; its static fallback is incomplete), click-through pcb + schematic, perf-canvas, perf-pour, perf-ui, perf-sch, integration-browser (Chromium image),
#              format 2 folder Git history and review in Chromium,
#              the GPU renderer pixel test (scripts/gpu-pixels.sh; skipped when the container's Chromium has no WebGL2)
set -u
step=${1:?usage: linux-steps.sh STEP}
export HOME=/work/home GIT_CONFIG_NOSYSTEM=1 PYTHONDONTWRITEBYTECODE=1 TMPDIR=/work/tmp
mkdir -p "$HOME" "$TMPDIR"
git config --global user.name "Waffle CI" 2>/dev/null
git config --global user.email "ci@invalid" 2>/dev/null
git config --global init.defaultBranch main 2>/dev/null
cp -R /src /work/waffle && cd /work/waffle || exit 2
[ -d /opt/ci-node/node_modules ] && ln -s /opt/ci-node/node_modules node_modules
fail=0
run() { # run LABEL CMD...: prints a header, runs, records failure without stopping the step
  label=$1; shift
  echo "::group::$label"
  "$@"; rc=$?
  echo "::endgroup::"
  if [ $rc -eq 0 ]; then echo "PASS  $label"; else echo "FAIL  $label (exit $rc)"; fail=1; fi
}

installed_native_open() (
    work=$(mktemp -d "$TMPDIR/waffle-native-open.XXXXXX") || exit 1
    trap 'rm -rf "$work"' EXIT HUP INT TERM
    loose="$work/loose"
    indexed="$work/indexed"
    workshop=tests/fixtures/format-2/workshop
    mkdir -p "$loose" "$indexed" "$work/tmp" "$work/runtime" || exit 1
    chmod 700 "$work/runtime" || exit 1
    cp "$workshop/Board.wpcb" "$workshop/Sensor.wsch" "$workshop/Assembly.wdraw" \
       "$workshop/Panel.wpanel" "$workshop/libraries/Sense pad.wlib" "$loose/" || exit 1
    cp -R "$workshop/." "$indexed/" || exit 1
    chown -R nobody:nogroup "$work" || exit 1
    open_member() {
        runuser -u nobody -- env "TMPDIR=$work/tmp" "XDG_RUNTIME_DIR=$work/runtime" \
            dbus-run-session -- xvfb-run -a -s '-screen 0 1380x860x24' \
            python3 native/tests/linux-harness/durable-open.py "$@"
    }
    result=0
    for file in "$loose"/*; do open_member "$file" || result=1; done
    open_member "$indexed/Sensor.wsch" --indexed || result=1
    exit "$result"
)

case $step in
  deb-install) ;;
  *) python3 -B scripts/prepare-assets.py || exit 2 ;;
esac

case $step in
  rust)
    cargo --version
    run "Rust kernels: cargo test + reproducible engine-core.js" python3 scripts/build-engine.py --check ;;
  node)
    node --version
    SKIP="integration-browser palette-actions.browser collab-pair-browser collab-remote-scope-browser browser-format-2-git browser-apricot-readonly browser-apricot-native-query browser-import-export-target browser-dialog-geometry browser-dialog-safe-area browser-titlebar-safe-area browser-surface-motion browser-workbench-spatial browser-dock-beta ${NODE_SKIP:-}" scripts/ci/node-suites.sh > /work/node.log; cat /work/node.log
    run "node suites vs tests/known-failures.txt" python3 scripts/ci/check-results.py node /work/node.log ;;
  mcp)
    run "tests/automation/mcp.py" python3 tests/automation/mcp.py
    run "tests/automation/mcp_runner.py" python3 tests/automation/mcp_runner.py
    run "tests/automation/headless-parity.py" python3 tests/automation/headless-parity.py
    run "tests/integration/eco-e2e.py" python3 tests/integration/eco-e2e.py
    run "tests/formats/compat-mcp.py" python3 tests/formats/compat-mcp.py
    run "batch DRC parity in CLI and MCP" python3 -B tests/checks/mcp-drc-parity.py
    run "native compatibility corpus in CLI and MCP" python3 tests/formats/mcp-format-2.py
    run "ODB++ opt-in and native output routes" python3 tests/formats/butter-odb.py
    run "Slides in CLI and MCP" python3 tests/automation/butter-acceptance.py --feature slides
    run "Slides vector PDF and presenter state in MCP" python3 tests/notebook/butter-slides.py
    run "Butter tables on the native MCP transport" python3 -B tests/automation/mcp-butter-tables.py
    run "native project Git snapshots" python3 tests/formats/format-2-git.py
    run "plain Git and Waffle document merges" python3 tests/formats/format-2-document-merge.py
    run "tests/project/mcp-source-save.py" python3 tests/project/mcp-source-save.py
    run "native/tests/import_save_exports.py" python3 native/tests/import_save_exports.py
    for test_path in tests/history/mcp_diff.py tests/history/mcp_review.py tests/formats/mcad-mcp.py tests/automation/mcp-authoring.py tests/automation/mcp-signals.py tests/pcb/mcp-bus-route.py tests/library/mcp-generic-parts.py tests/library/mcp-symbol-wizard.py tests/formats/altium-fab-parity-mcp.py tests/project/collab-relay.py tests/project/security-git.py tests/automation/security-proposals.py tests/maintenance/types-model.py tests/analysis/si-ngspice.py; do run "tests/${test_path##*/}" python3 "$test_path"; done ;;
  static)
    if [ -d .git ]; then
      run "tracked source roots" python3 -B scripts/check-source-roots.py
    else
      echo "SKIP container source roots: worktrees are checked on the host"
    fi
    run "tests/maintenance/css-tokens.py" python3 tests/maintenance/css-tokens.py
    run "single geometry owner" python3 -B tests/maintenance/single-owner.py
    run "tests/editor/dialog-inventory.py" python3 tests/editor/dialog-inventory.py
    run "release version mirrors" python3 -B scripts/release-version.py --check
    run "gen-shortcuts --check" python3 scripts/gen-shortcuts.py --check
    run "Apricot palette budget evaluator" python3 -B tests/editor/test-apricot-palette-budget.py
    run "generated app assets" python3 scripts/prepare-assets.py --check
    run "clean worker build" python3 tests/maintenance/generated-assets.py
    run "i18n-extract tests" python3 tests/maintenance/i18n-extract.py
    run "startup-budget --static" zsh scripts/startup-budget.sh --static
    run "compat-guard --check" python3 scripts/compat-guard.py --check
    run "compat-corpus --check" python3 scripts/compat-corpus.py --check
    run "independent native format reader" python3 tests/formats/format-2-independent-reader.py
    run "generate collaboration installers" python3 scripts/gen-collab-launch.py
    run "gen-collab-launch --check" python3 scripts/gen-collab-launch.py --check
    run "gen-extension-api --check" python3 scripts/gen-extension-api.py --check
    run "gen-schema --check" python3 integrations/vscode/scripts/gen-schema.py --check
    run "bundle-viewer --check" python3 integrations/vscode/scripts/bundle-viewer.py --check
    run "typecheck (tsc --noEmit, types/baseline.json)" sh scripts/typecheck.sh ;;
  native)
    run "python syntax" python3 -m compileall -q -x '/(target|node_modules)/' native mcp scripts tests
    run "waffle.py imports" python3 -c "import importlib.util as u; s=u.spec_from_file_location('waffle','native/linux/waffle.py'); m=u.module_from_spec(s); s.loader.exec_module(m); assert callable(m.main)"
    run "waffle.py --version" python3 native/linux/waffle.py --version
    run "standalone native member recovery" python3 native/tests/folder-transaction/linux-standalone.py
    for t in git_head host_state project_journal source_copies external_tools lan_relay power_saver; do run "native/tests/$t.py" python3 native/tests/$t.py; done ;;
  webkitgtk)
    run "WebKitGTK web view smoke" xvfb-run -a -s "-screen 0 1440x900x24" python3 scripts/ci/webkitgtk-smoke.py
    run "GTK3 native editor startup" xvfb-run -a -s "-screen 0 1440x900x24" python3 native/tests/linux-harness/gdk-startup.py
    # The real host: it must still be running after 20 s (timeout's 124) without a traceback.
    echo "::group::waffle.py under Xvfb"
    xvfb-run -a -s "-screen 0 1440x900x24" timeout 20 python3 native/linux/waffle.py > /work/host.log 2>&1; rc=$?
    cat /work/host.log; echo "::endgroup::"
    if [ $rc -eq 124 ] && ! grep -q Traceback /work/host.log; then echo "PASS  waffle.py stays up under Xvfb"
    else echo "FAIL  waffle.py stays up under Xvfb (exit $rc)"; fail=1; fi
    # UI probes shared with the macOS harness: menus, context menus (right-click), Ctrl/Alt+click
    # net highlight, dialogs, CSS and tokens, all with real X input events. No window manager, so
    # the window sits at (0, 0) and page coordinates are screen coordinates.
    run "WebKitGTK UI probes" xvfb-run -a -s "-screen 0 1380x860x24" python3 native/tests/linux-harness/ui.py /work/ui
    [ -d /out ] && [ -w /out ] && cp -R /work/ui/shots /out/ui-shots 2>/dev/null
    # GTK backing scale is fixed when creating the WebView. Each launch has its own profile.
    for scale in 1 2; do
      field_work="/work/ui/field-text-$scale"
      run "WebKitGTK field text at ${scale}x" env UI_ONLY=field-text GDK_SCALE="$scale" UI_TIMEOUT=90 \
        XDG_DATA_HOME="$field_work/data" XDG_CACHE_HOME="$field_work/cache" XDG_CONFIG_HOME="$field_work/config" \
        xvfb-run -a -s "-screen 0 $((1380 * scale))x$((860 * scale))x24" python3 native/tests/linux-harness/ui.py "$field_work"
      [ -d /out/ui-shots ] && [ -w /out/ui-shots ] && cp -R "$field_work/shots" "/out/ui-shots/field-text-$scale" 2>/dev/null
    done
    : ;;
  deb)
    deb=$(python3 -B scripts/build-deb.py --filename) || exit 2
    run "build-deb.py" python3 scripts/build-deb.py --output "/out/$deb"
    run "native/tests/debian_package.py" python3 native/tests/debian_package.py "/out/$deb" ;;
  deb-install)
    deb=$(python3 -B scripts/build-deb.py --filename) || exit 2
    run "Debian package rename and collision handling" python3 native/tests/debian_package.py --upgrade "/out/$deb"
    run "dpkg -i" dpkg -i "/out/$deb"
    run "installed waffle --version" waffle --version
    run "installed waffle-mcp starts" sh -c 'waffle-mcp --help >/dev/null 2>&1 || test $? -le 2'
    run "desktop file" desktop-file-validate /usr/share/applications/org.waffle.editor.desktop
    run "installed GTK native document Open" installed_native_open ;;
  soak)
    export CHROME=/usr/local/bin/chromium-ci
    "$CHROME" --version
    run "cached quick-fix lifetime and actions" node --expose-gc tests/checks/insights-fix-lifetime.js
    run "five-minute editing soak" node tests/editor/browser-editing-soak.js --ci --report /work/editing-soak.json
    if [ -d /out ] && [ -f /work/editing-soak.json ]; then
      cp /work/editing-soak.json /out/checkpoints.json || fail=1
    fi ;;
  browser)
    export CHROME=/usr/local/bin/chromium-ci
    "$CHROME" --version
    run "reachability --check" python3 scripts/reachability.py --check
    run "click-through pcb" zsh scripts/click-through.sh pcb
    run "click-through schematic" zsh scripts/click-through.sh schematic
    run "perf-canvas" zsh scripts/perf-canvas.sh
    run "perf-pour" zsh scripts/perf-pour.sh
    run "perf-ui" zsh scripts/perf-ui.sh --skip-if-no-browser
    run "perf-sch" zsh scripts/perf-sch.sh --skip-if-no-browser
    run "gpu-pixels (GPU vs 2D)" zsh scripts/gpu-pixels.sh --skip-if-no-webgl
    run "Geometry through zoom in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/canvas/browser-zoom-geometry.js
    scripts/ci/node-suites.sh integration-browser palette-actions.browser > /work/browser.log; cat /work/browser.log
    run "browser suites vs tests/known-failures.txt" python3 scripts/ci/check-results.py node /work/browser.log
    run "Dialog geometry in Chromium (light, dark and touch)" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-dialog-geometry.cjs
    run "Dialog safe area and Footprint Editor quick add in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-dialog-safe-area.cjs
    run "Dialog, menu and popover motion in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/ui/browser-surface-motion.cjs
    run "Document tabs and workbench motion in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-workbench-spatial.cjs
    run "Docks, Messages columns, pane resizing and tab drop zones in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-dock-beta.cjs
    run "Shared surface focus and motion in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-motion-contract.js
    run "Keyboard project, export, Undo and tutorial motion in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-rare-motion.js
    run "Collaboration pairing and local-network consent in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/project/collab-pair-browser.cjs
    run "A remote live-session edit re-checks only what it touched, in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/project/collab-remote-scope-browser.cjs
    run "format 2 Git folder history in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/formats/browser-format-2-git.cjs
    run "widget and extension first use in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/notebook/browser-widget-demand.js
    run "Apricot Preview saved notebook artwork and editing in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/project/browser-apricot-readonly.cjs
    run "Apricot Preview saved design queries in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/checks/browser-apricot-native-query.cjs
    run "Fabrication rule UUIDs through native save in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/checks/browser-fab-rule-ids.js
    run "Slides live design context in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/notebook/browser-butter-slides.js
    run "ODB++ 25,600-object export in a Chromium worker" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/formats/browser-odb-worker.js
    run "Accessible first Save in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/formats/browser-import-save-view.js
    run "Palette appearance and platform shortcuts in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-palette-view.js
    run "Foreign import recovery in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/project/browser-foreign-drafts.js
    run "Remembered foreign export targets in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/formats/browser-import-export-target.cjs
    run "Browser source picker and remembered export in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/formats/browser-import-source-picker.js
    run "Apricot Preview Labs on file and HTTP in Chromium" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/editor/browser-preview-labs.js
    run "Butter table authoring, clipboard and viewport" timeout "${NODE_TEST_TIMEOUT:-300}" node tests/notebook/browser-butter-tables.js ;;
  *) echo "unknown step $step" >&2; exit 2 ;;
esac
exit $fail
