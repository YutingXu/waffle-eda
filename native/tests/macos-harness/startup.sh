#!/bin/zsh
# Launch frames: the real Desktop class launched cold, its window captured from the window server every few
# milliseconds from process start until the start page settles (startup-probes.swift). Fails when any frame
# before the settled start page differs from it (the bare window, the empty workbench, a theme switch) or the
# first frame's backdrop is not the theme's --app colour. Runs in light and dark appearance, with a fresh
# profile, with a recent project, a recovery prompt, and a saved board or schematic reopening.
# Usage: native/tests/macos-harness/startup.sh [work-folder]   (frames: <work-folder>/<case>/shots/startup-*.png)
# Env: HARNESS_INSTALL as for ui.sh (default ~/Library/Caches/atrium-harness-startup). STARTUP_CASES (default
#      runs all light and dark fixtures). STARTUP_SKIP_BUILD=1 uses the supplied installed harness.
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-startup}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-startup}
mkdir -p $W
if [[ ${STARTUP_SKIP_BUILD:-0} != 1 ]]; then
  HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
fi
rc=0

launch() {  # case suite log [env...]
  local c=$1 suite=$2 log=$3; shift 3
  env HARNESS_SUITE=$suite HARNESS_APPEARANCE=${c%%-*} HARNESS_WORK=$W/$c "$@" \
    HARNESS_EARLY_PROBE=$H/startup-early.js timeout ${STARTUP_TIMEOUT:-90} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E '^(PASS|FAIL|NOTE|RESULT)' > $log
  sed "s/^/[$c] /" $log
  grep -q '^FAIL' $log && rc=1
  grep -qx 'RESULT ok' $log || rc=1
}
for c in ${=STARTUP_CASES:-dark light dark-recent light-recent dark-reopen light-reopen dark-reopen-no-start light-reopen-no-start dark-reopen-sheet light-reopen-sheet dark-prompt light-prompt}; do
  case $c in
    # A recent project on record: the start page lists it.
    *-recent) launch $c startup $W/$c.log HARNESS_EPHEMERAL=1 HARNESS_RECENT_PROJECT=$W/$c/proj/Demo/Demo.waffle ;;
    # The last project, closed cleanly, reopens instead of the start page. Both launches share a WebKit
    # store in the work folder (HARNESS_TOUR_PUBLIC_WEB_DATA, which needs an early probe script).
    *-reopen|*-reopen-no-start|*-reopen-sheet|*-prompt) store=(HARNESS_TOUR_PUBLIC_WEB_DATA=1)
      if [[ $c == *-reopen-sheet ]]; then store+=(HARNESS_STARTUP_TARGET=sheet); fi
      if [[ $c == *-prompt ]]; then store+=(HARNESS_STARTUP_TARGET=prompt); fi
      if [[ $c == *-no-start ]]; then store+=(HARNESS_START_PAGE_NEVER=1); fi
      launch $c startup-seed $W/$c-seed.log $store
      launch $c startup-reopen $W/$c.log $store ;;
    *) launch $c startup $W/$c.log HARNESS_EPHEMERAL=1 ;;
  esac
done
exit $rc
