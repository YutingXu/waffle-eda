#!/bin/zsh
# Drives the real macOS Desktop class (native/macos/main.swift) in-process: boot, start page,
# extension sandbox, ⌘⇧Esc, recent files and File › Open Recent, native transactions,
# private drafts, library reads, print panel and PDF export. Uses its own bundle id and a scratch
# Application Support folder, so the user's Waffle data is not touched.
# Usage: native/tests/macos-harness/run.sh [work-folder]   (screenshots: <work-folder>/shots)
# HARNESS_SUITE=crash tests renderer restart, second-crash close and recovery in the next launch.
# HARNESS_SUITE=hang tests the not-responding sheet and its Restart Editor (an endless loop in the page).
# HARNESS_SUITE=kill kills the whole app (SIGKILL) with unsaved work, then launches it again to recover.
# HARNESS_SUITE=keys tests native menu equivalents and keyboard events through WebKit.
# HARNESS_SUITE=field-text checks painted field text against live labels in WebKit.
# HARNESS_SUITE=projects tests native file bindings, separate project windows and recent-file activation.
# HARNESS_SUITE=import-quit tests the imported-project Quit sheet and private draft after relaunch.
# HARNESS_SUITE=history tests a branched project through the file-origin web view and native Git binding.
# HARNESS_SUITE=close tests the unsaved-changes sheet (Save / Cancel / Don't Save) on close, and quitting
# with two unsaved windows (Review Changes…), ending with a real quit that saves both.
# HARNESS_INSTALL moves the installed app (see build.sh). HARNESS_REUSE_APP=1 uses the existing
# harness bundle. The broader WebKit UI probes are ui.sh.
H=${0:A:h}; W=${1:-${TMPDIR:-/tmp}/atrium-harness-work}
export HARNESS_EPHEMERAL=1
if [[ ${HARNESS_SUITE:-} == field-text ]]; then
    export HARNESS_SUITE=ui HARNESS_PROBES=$H/field-text.js
fi
if [[ ${HARNESS_REUSE_APP:-0} != 1 ]]; then $H/build.sh >/dev/null || exit 2; fi
log=$(mktemp -t atrium-harness)
bundle=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness}/WaffleHarness.app
codesign --verify --deep --strict "$bundle" || exit 2
probe=
altium=
trap 'rm -f -- "$log" "$log.err"; if [[ -n $probe ]]; then rm -f -- "$probe"; fi; if [[ -n $altium ]]; then rm -rf -- "$altium"; fi' EXIT
if [[ ${HARNESS_SUITE:-} == (projects|import-quit) ]]; then
    # Copy the test source before the app starts. An app reading from the real Documents
    # directory may wait on macOS's privacy prompt.
    altium=${W:A}.altium
    rm -rf -- "$altium"
    mkdir -p "$altium" || exit 2
    rsync -a --exclude .git "${HARNESS_ALTIUM:-${H:h:h:h}/tests/fixtures/altium/pidp11-io-expander}/" "$altium/" || exit 2
    export HARNESS_ALTIUM=$altium
fi
if [[ ${HARNESS_SUITE:-} == (kill|crash|import-quit) ]]; then
    # Private persistent WebKit data belongs solely to this scratch project, across both launches.
    probe=$(mktemp -t atrium-harness-preload)
    export HARNESS_TOUR_PUBLIC_WEB_DATA=1 HARNESS_EARLY_PROBE=$probe
    phase=${HARNESS_SUITE}
    case "$phase" in
        kill) marker='RESULT killed' ;;
        crash) marker='RESULT closed after second crash' ;;
        import-quit) marker='RESULT kept foreign draft' ;;
    esac
    HARNESS_WORK=$W timeout 120 "$bundle/Contents/MacOS/Waffle" 2>&1 | grep --line-buffered -E "^(PASS|FAIL|SKIP|NOTE|RESULT)" | tee "$log"
    first_status=${pipestatus[1]}
    if ! grep -qx "$marker" "$log" || grep -q "^FAIL" "$log" || [[ $phase != kill && $first_status != 0 ]]; then
        print "FAIL  the first launch did not complete the recovery setup"
        exit 1
    fi
    HARNESS_SUITE=${phase}2 HARNESS_WORK=$W timeout 300 "$bundle/Contents/MacOS/Waffle" 2>&1 | grep --line-buffered -E "^(PASS|FAIL|SKIP|NOTE|RESULT)" | tee "$log"
    rc=${pipestatus[1]}
elif [[ ${HARNESS_SUITE:-} == projects ]]; then
    # LaunchServices gives the app its normal foreground status for key/main window checks.
    timeout 300 /usr/bin/open -n -W --env HARNESS_SUITE=projects --env HARNESS_EPHEMERAL=1 --env HARNESS_WORK="$W" --env HARNESS_ALTIUM="$altium" --stdout "$log" --stderr "$log.err" "$bundle"
    rc=$?
    grep -E "^(PASS|FAIL|SKIP|NOTE|RESULT)" "$log"
    if [[ -s $log.err ]]; then cat "$log.err" >&2; fi
else
    HARNESS_WORK=$W timeout 300 "$bundle/Contents/MacOS/Waffle" 2>&1 | grep --line-buffered -E "^(PASS|FAIL|SKIP|NOTE|RESULT)" | tee $log
    rc=${pipestatus[1]}
fi
# The app's exit status is not reliable (closing the last window terminates it with 0), so the
# run fails on any FAIL line or a missing "RESULT ok".
if grep -q "^FAIL" "$log" || ! grep -qx "RESULT ok" "$log"; then rc=1; fi
if [[ ${HARNESS_SUITE:-} == close ]]; then
    # The real quit at the end saved both windows during termination (the harness exits with a FAIL
    # line if the quit has not finished within a minute).
    if grep -q '"Quit final A"' "$W/proj/QuitA/QuitA.waffle" && grep -q '"Quit final B"' "$W/proj/QuitB/QuitB.waffle"; then
        print "PASS  quitting saved both native manifests before the app ended"
    else print "FAIL  quitting did not save both windows"; rc=1; fi
fi
if [[ ${HARNESS_SUITE:-} != (folder|legacy-folder) ]] && [[ -d "$W/proj" ]]; then
    pending=$(find "$W/proj" -type f \( -path '*/.waffle/journal/active' -o -name '*.waffle~' -o -name '*.waffle.journal' \))
    if [[ -n $pending ]]; then
        print "FAIL  unexpected project journals at exit: $pending"; rc=1
    else
        print "PASS  all project transactions settled and recovery stayed in the private profile"
    fi
fi
exit $rc
